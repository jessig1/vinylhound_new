import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MAX_SCANS_PER_BATCH,
  type AnalyzeScanJob,
} from "@vinylhound/contracts";

import { createDatabase } from "./database.js";
import {
  deleteAccount,
  getAccountExportForUser,
} from "./account-repository.js";
import {
  getBatchCostSummary,
  getScanForUser,
  getUsageSummaryForUser,
  listScanSummariesForUser,
  prepareScanAnalysis,
} from "./analysis-repository.js";
import {
  confirmScan,
  getScanConfirmationForUser,
} from "./confirmation-repository.js";
import {
  deleteLibraryItem,
  getLibraryItemForUser,
  listLibraryItemsForUser,
  updateLibraryItem,
} from "./library-repository.js";
import {
  cancelScan,
  cleanupAbandonedScans,
  completeImageUpload,
  createOrGetBatch,
  createOrGetImageUpload,
  createOrGetScan,
  dispatchNextOutboxMessage,
  getBatchForUser,
  getOrCreateUserIdByClerkId,
  getScanQuotaHeadroomForUser,
  retryScan,
  submitScan,
} from "./scan-repository.js";
import {
  albums,
  catalogReferences,
  imageAssets,
  libraryCopies,
  libraryItems,
  outboxMessages,
  releases,
  scanAttempts,
  scanCandidates,
  scanConfirmations,
  scans,
  users,
} from "./schema.js";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required for database integration tests.");
}

const database = createDatabase({ connectionString, maxConnections: 2 });
const userId = randomUUID();

beforeAll(async () => {
  await database.db.insert(users).values({ id: userId });
});

/**
 * The outbox table is shared across tests in this file, so a prior test's
 * unpublished row can be dispatched before the one under test. Dispatch
 * repeatedly (draining unrelated rows with a no-op publish) until the target
 * job ID is reached.
 */
async function dispatchUntil(
  targetJobId: string,
  publishTarget: (job: AnalyzeScanJob) => Promise<void>,
) {
  for (let attempts = 0; attempts < 50; attempts += 1) {
    const result = await dispatchNextOutboxMessage(
      database.db,
      async (job, idempotencyKey) => {
        if (idempotencyKey === targetJobId) {
          await publishTarget(job);
        }
      },
      new Date(Date.now() + 1_000),
    );
    if (result.status === "idle") {
      throw new Error(`Target job ${targetJobId} was never dispatched.`);
    }
    if (result.jobId === targetJobId) {
      return result;
    }
  }
  throw new Error(`Target job ${targetJobId} was not reached in time.`);
}

afterAll(async () => {
  await database.db.delete(users).where(eq(users.id, userId));
  await database.close();
});

describe("initial scan persistence schema", () => {
  it("replays idempotent scan and upload commands without duplicate rows", async () => {
    const scanInput = {
      userId,
      source: "single_upload" as const,
      idempotencyKey: `repository-scan-${randomUUID()}`,
    };
    const createdScan = await createOrGetScan(database.db, scanInput);
    const replayedScan = await createOrGetScan(database.db, scanInput);

    expect(createdScan.created).toBe(true);
    expect(replayedScan.created).toBe(false);
    expect(replayedScan.record.id).toBe(createdScan.record.id);

    const uploadInput = {
      userId,
      scanId: createdScan.record.id,
      idempotencyKey: `repository-upload-${randomUUID()}`,
      filename: "front.png",
      mimeType: "image/png" as const,
      sizeBytes: 512,
      checksumSha256: "b".repeat(64),
      maxImages: 12,
    };
    const createdUpload = await createOrGetImageUpload(
      database.db,
      uploadInput,
    );
    const replayedUpload = await createOrGetImageUpload(
      database.db,
      uploadInput,
    );

    expect(createdUpload.created).toBe(true);
    expect(replayedUpload.created).toBe(false);
    expect(replayedUpload.record.id).toBe(createdUpload.record.id);
  });

  it("stores a scan, completed image, and attempt audit row", async () => {
    const [scan] = await database.db
      .insert(scans)
      .values({
        userId,
        source: "camera",
        idempotencyKey: `scan-${randomUUID()}`,
      })
      .returning();

    expect(scan?.status).toBe("awaiting_upload");

    await database.db.insert(imageAssets).values({
      scanId: scan!.id,
      idempotencyKey: `image-${randomUUID()}`,
      objectKey: `${userId}/${scan!.id}/${randomUUID()}`,
      filename: "front-cover.jpg",
      viewType: "front",
      mimeType: "image/jpeg",
      sizeBytes: 1_024,
      checksumSha256: "a".repeat(64),
      completedAt: new Date(),
      width: 800,
      height: 800,
      analysisSizeBytes: 200,
      analysisWidth: 800,
      analysisHeight: 800,
      thumbnailSizeBytes: 40,
    });

    await database.db.insert(scanAttempts).values({
      scanId: scan!.id,
      attemptNumber: 1,
      status: "succeeded",
      model: "integration-test-model",
      promptVersion: "integration-test.v1",
      providerResponseId: `response-${randomUUID()}`,
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      durationMs: 42,
      completedAt: new Date(),
    });

    const stored = await database.db.query.scans.findFirst({
      where: eq(scans.id, scan!.id),
    });

    expect(stored).toMatchObject({
      id: scan!.id,
      userId,
      source: "camera",
      status: "awaiting_upload",
    });
  });

  it("submits atomically, replays safely, and dispatches the outbox", async () => {
    const scan = await createOrGetScan(database.db, {
      userId,
      source: "single_upload",
      idempotencyKey: `submit-scan-${randomUUID()}`,
    });
    const upload = await createOrGetImageUpload(database.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey: `submit-upload-${randomUUID()}`,
      filename: "front.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1_024,
      checksumSha256: "c".repeat(64),
      maxImages: 12,
    });
    await completeImageUpload(database.db, {
      userId,
      scanId: scan.record.id,
      imageId: upload.record.id,
      width: 800,
      height: 800,
      analysisSizeBytes: 200,
      analysisWidth: 800,
      analysisHeight: 800,
      thumbnailSizeBytes: 40,
    });

    const idempotencyKey = `submit-${randomUUID()}`;
    const submitted = await submitScan(database.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey,
    });
    const replayed = await submitScan(database.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey,
    });

    expect(submitted.created).toBe(true);
    expect(submitted.record.status).toBe("queued");
    expect(submitted.job).toMatchObject({
      scanId: scan.record.id,
      userId,
      attemptNumber: 1,
      imageIds: [upload.record.id],
    });
    expect(replayed).toMatchObject({
      created: false,
      jobId: submitted.jobId,
    });

    const storedMessages = await database.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.aggregateId, scan.record.id));
    expect(storedMessages).toHaveLength(1);
    expect(storedMessages[0]).toMatchObject({
      publishAttempts: 0,
      publishedAt: null,
      idempotencyKey: submitted.jobId,
    });

    const firstDispatchAt = new Date(Date.now() + 1_000);
    const deferred = await dispatchNextOutboxMessage(
      database.db,
      async () => {
        throw new Error("synthetic Redis outage");
      },
      firstDispatchAt,
    );
    expect(deferred).toMatchObject({
      status: "deferred",
      jobId: submitted.jobId,
    });

    const publishedJobs: Array<{ jobId: string; scanId: string }> = [];
    const published = await dispatchNextOutboxMessage(
      database.db,
      async (job, jobId) => {
        publishedJobs.push({ jobId, scanId: job.scanId });
      },
      new Date(firstDispatchAt.getTime() + 3_000),
    );
    expect(published).toMatchObject({
      status: "published",
      jobId: submitted.jobId,
    });
    expect(publishedJobs).toEqual([
      { jobId: submitted.jobId, scanId: scan.record.id },
    ]);

    const [publishedMessage] = await database.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.aggregateId, scan.record.id));
    expect(publishedMessage).toMatchObject({
      publishAttempts: 2,
      lastError: null,
    });
    expect(publishedMessage?.publishedAt).toBeInstanceOf(Date);
  });

  it("forwards a caller-supplied correlationId onto the outbox row and the worker attempt it produces", async () => {
    const scan = await createOrGetScan(database.db, {
      userId,
      source: "single_upload",
      idempotencyKey: `correlation-scan-${randomUUID()}`,
    });
    const upload = await createOrGetImageUpload(database.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey: `correlation-upload-${randomUUID()}`,
      filename: "front.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1_024,
      checksumSha256: "d".repeat(64),
      maxImages: 12,
    });
    await completeImageUpload(database.db, {
      userId,
      scanId: scan.record.id,
      imageId: upload.record.id,
      width: 800,
      height: 800,
      analysisSizeBytes: 200,
      analysisWidth: 800,
      analysisHeight: 800,
      thumbnailSizeBytes: 40,
    });

    const correlationId = `trace-${randomUUID()}`;
    const submitted = await submitScan(database.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey: `correlation-submit-${randomUUID()}`,
      correlationId,
    });
    expect(submitted.job.correlationId).toBe(correlationId);

    const [storedMessage] = await database.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.aggregateId, scan.record.id));
    expect(storedMessage).toMatchObject({ correlationId });

    const prepared = await prepareScanAnalysis(database.db, {
      job: submitted.job,
      deliveryAttempt: 1,
      model: "integration-test-model",
      promptVersion: "integration-test.v1",
    });
    if (prepared.status !== "ready") {
      throw new Error(
        `Expected the attempt to be ready, got ${prepared.status}.`,
      );
    }

    const [attemptRow] = await database.db
      .select()
      .from(scanAttempts)
      .where(eq(scanAttempts.id, prepared.attemptId));
    expect(attemptRow).toMatchObject({ correlationId });
  });

  it("rejects a submission that exceeds the per-user daily analysis quota", async () => {
    const quotaUserId = randomUUID();
    await database.db.insert(users).values({ id: quotaUserId });
    const createCompletedScan = async () => {
      const scan = await createOrGetScan(database.db, {
        userId: quotaUserId,
        source: "single_upload",
        idempotencyKey: `quota-scan-${randomUUID()}`,
      });
      const upload = await createOrGetImageUpload(database.db, {
        userId: quotaUserId,
        scanId: scan.record.id,
        idempotencyKey: `quota-upload-${randomUUID()}`,
        filename: "front.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 512,
        checksumSha256: "b".repeat(64),
        maxImages: 12,
      });
      await completeImageUpload(database.db, {
        userId: quotaUserId,
        scanId: scan.record.id,
        imageId: upload.record.id,
        width: 800,
        height: 800,
        analysisSizeBytes: 200,
        analysisWidth: 800,
        analysisHeight: 800,
        thumbnailSizeBytes: 40,
      });
      return scan.record.id;
    };

    const first = await createCompletedScan();
    await submitScan(database.db, {
      userId: quotaUserId,
      scanId: first,
      idempotencyKey: `quota-submit-${randomUUID()}`,
    });
    const second = await createCompletedScan();

    await expect(
      submitScan(database.db, {
        userId: quotaUserId,
        scanId: second,
        idempotencyKey: `quota-submit-${randomUUID()}`,
        quotaLimits: {
          dailyAnalysisLimit: 1,
          activeScanLimit: 20,
          monthlySpendLimitUsd: 20,
          scanCostReservationUsd: 0.25,
        },
      }),
    ).rejects.toMatchObject({ code: "quota_exceeded" });

    await database.db.delete(users).where(eq(users.id, quotaUserId));
  });

  it("reports advisory quota headroom that reflects active scans", async () => {
    const headroomUserId = randomUUID();
    await database.db.insert(users).values({ id: headroomUserId });

    const fresh = await getScanQuotaHeadroomForUser(database.db, {
      userId: headroomUserId,
      limits: {
        dailyAnalysisLimit: 100,
        activeScanLimit: 1,
        monthlySpendLimitUsd: 20,
        scanCostReservationUsd: 0.25,
      },
    });
    expect(fresh).toMatchObject({
      admissible: true,
      blockedBy: null,
      activeScans: { used: 0, limit: 1, remaining: 1 },
    });

    const scan = await createOrGetScan(database.db, {
      userId: headroomUserId,
      source: "single_upload",
      idempotencyKey: `headroom-scan-${randomUUID()}`,
    });
    const upload = await createOrGetImageUpload(database.db, {
      userId: headroomUserId,
      scanId: scan.record.id,
      idempotencyKey: `headroom-upload-${randomUUID()}`,
      filename: "front.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 512,
      checksumSha256: "c".repeat(64),
      maxImages: 12,
    });
    await completeImageUpload(database.db, {
      userId: headroomUserId,
      scanId: scan.record.id,
      imageId: upload.record.id,
      width: 800,
      height: 800,
      analysisSizeBytes: 200,
      analysisWidth: 800,
      analysisHeight: 800,
      thumbnailSizeBytes: 40,
    });
    await submitScan(database.db, {
      userId: headroomUserId,
      scanId: scan.record.id,
      idempotencyKey: `headroom-submit-${randomUUID()}`,
    });

    const afterSubmit = await getScanQuotaHeadroomForUser(database.db, {
      userId: headroomUserId,
      limits: {
        dailyAnalysisLimit: 100,
        activeScanLimit: 1,
        monthlySpendLimitUsd: 20,
        scanCostReservationUsd: 0.25,
      },
    });
    expect(afterSubmit).toMatchObject({
      admissible: false,
      blockedBy: "active_scan_limit",
      activeScans: { used: 1, limit: 1, remaining: 0 },
    });

    await database.db.delete(users).where(eq(users.id, headroomUserId));
  });

  it("rejects creating a new scan before any upload work when the active-scan limit is already exhausted", async () => {
    const admissionUserId = randomUUID();
    await database.db.insert(users).values({ id: admissionUserId });

    const active = await createOrGetScan(database.db, {
      userId: admissionUserId,
      source: "single_upload",
      idempotencyKey: `admission-scan-active-${randomUUID()}`,
    });
    const activeUpload = await createOrGetImageUpload(database.db, {
      userId: admissionUserId,
      scanId: active.record.id,
      idempotencyKey: `admission-upload-${randomUUID()}`,
      filename: "front.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 512,
      checksumSha256: "d".repeat(64),
      maxImages: 12,
    });
    await completeImageUpload(database.db, {
      userId: admissionUserId,
      scanId: active.record.id,
      imageId: activeUpload.record.id,
      width: 800,
      height: 800,
      analysisSizeBytes: 200,
      analysisWidth: 800,
      analysisHeight: 800,
      thumbnailSizeBytes: 40,
    });
    await submitScan(database.db, {
      userId: admissionUserId,
      scanId: active.record.id,
      idempotencyKey: `admission-submit-${randomUUID()}`,
    });

    const blockedIdempotencyKey = `admission-scan-blocked-${randomUUID()}`;
    await expect(
      createOrGetScan(database.db, {
        userId: admissionUserId,
        source: "single_upload",
        idempotencyKey: blockedIdempotencyKey,
        quotaLimits: {
          dailyAnalysisLimit: 100,
          activeScanLimit: 1,
          monthlySpendLimitUsd: 20,
          scanCostReservationUsd: 0.25,
        },
      }),
    ).rejects.toMatchObject({ code: "quota_exceeded" });

    const blockedScan = await database.db.query.scans.findFirst({
      where: eq(scans.idempotencyKey, blockedIdempotencyKey),
    });
    expect(blockedScan).toBeUndefined();

    await database.db.delete(users).where(eq(users.id, admissionUserId));
  });

  it("cancels an abandoned awaiting_upload scan and leaves a recent one untouched", async () => {
    const cleanupUserId = randomUUID();
    await database.db.insert(users).values({ id: cleanupUserId });

    const abandoned = await createOrGetScan(database.db, {
      userId: cleanupUserId,
      source: "single_upload",
      idempotencyKey: `cleanup-scan-abandoned-${randomUUID()}`,
    });
    const abandonedUpload = await createOrGetImageUpload(database.db, {
      userId: cleanupUserId,
      scanId: abandoned.record.id,
      idempotencyKey: `cleanup-upload-${randomUUID()}`,
      filename: "front.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 512,
      checksumSha256: "e".repeat(64),
      maxImages: 12,
    });
    const staleTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    await database.db
      .update(scans)
      .set({ createdAt: staleTimestamp, updatedAt: staleTimestamp })
      .where(eq(scans.id, abandoned.record.id));
    await database.db
      .update(imageAssets)
      .set({ createdAt: staleTimestamp })
      .where(eq(imageAssets.id, abandonedUpload.record.id));

    const recent = await createOrGetScan(database.db, {
      userId: cleanupUserId,
      source: "single_upload",
      idempotencyKey: `cleanup-scan-recent-${randomUUID()}`,
    });

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    const canceled = await cleanupAbandonedScans(database.db, {
      olderThan: cutoff,
      limit: 50,
    });
    const canceledForUser = canceled.filter(
      (result) => result.userId === cleanupUserId,
    );

    expect(canceledForUser).toHaveLength(1);
    expect(canceledForUser[0]).toMatchObject({ scanId: abandoned.record.id });
    expect(canceledForUser[0]!.imageObjectKeys.sort()).toEqual(
      [
        `${cleanupUserId}/${abandoned.record.id}/${abandonedUpload.record.id}/original`,
        `${cleanupUserId}/${abandoned.record.id}/${abandonedUpload.record.id}/analysis`,
        `${cleanupUserId}/${abandoned.record.id}/${abandonedUpload.record.id}/thumbnail`,
      ].sort(),
    );

    const [abandonedStatus, recentStatus] = await Promise.all([
      database.db.query.scans.findFirst({
        where: eq(scans.id, abandoned.record.id),
      }),
      database.db.query.scans.findFirst({
        where: eq(scans.id, recent.record.id),
      }),
    ]);
    expect(abandonedStatus?.status).toBe("canceled");
    expect(recentStatus?.status).toBe("awaiting_upload");

    await database.db.delete(users).where(eq(users.id, cleanupUserId));
  });

  it("enforces per-user idempotency keys", async () => {
    const idempotencyKey = `duplicate-${randomUUID()}`;
    await database.db.insert(scans).values({
      userId,
      source: "single_upload",
      idempotencyKey,
    });

    await expect(
      database.db.insert(scans).values({
        userId,
        source: "single_upload",
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("rejects malformed checksums and invalid attempt numbers", async () => {
    const [scan] = await database.db
      .insert(scans)
      .values({
        userId,
        source: "single_upload",
        idempotencyKey: `constraints-${randomUUID()}`,
      })
      .returning();

    await expect(
      database.db.insert(imageAssets).values({
        scanId: scan!.id,
        idempotencyKey: `bad-image-${randomUUID()}`,
        objectKey: `${userId}/${scan!.id}/${randomUUID()}`,
        filename: "bad.jpg",
        viewType: "front",
        mimeType: "image/jpeg",
        sizeBytes: 50,
        checksumSha256: "not-a-sha-256-checksum".padEnd(64, "x"),
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    await expect(
      database.db.insert(scanAttempts).values({
        scanId: scan!.id,
        attemptNumber: 0,
        status: "processing",
        model: "integration-test-model",
        promptVersion: "integration-test.v1",
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("confirms a reviewed result idempotently and converts a wishlist item", async () => {
    const [scan] = await database.db
      .insert(scans)
      .values({
        userId,
        source: "camera",
        status: "needs_review",
        idempotencyKey: `confirm-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    const [attempt] = await database.db
      .insert(scanAttempts)
      .values({
        scanId: scan!.id,
        attemptNumber: 1,
        status: "succeeded",
        model: "integration-test-model",
        promptVersion: "integration-test.v1",
        providerResponseId: `response-${randomUUID()}`,
        durationMs: 25,
        completedAt: new Date(),
      })
      .returning();
    const [candidate] = await database.db
      .insert(scanCandidates)
      .values({
        scanAttemptId: attempt!.id,
        rank: 1,
        artist: "Miles Davis",
        title: "Kind of Blue",
        releaseYear: 1959,
        label: "Columbia",
        catalogNumber: "CS 8163",
        barcode: null,
        confidence: 0.89,
        evidence: ["Artist and title are visible."],
        warnings: ["Pressing is not established from the cover."],
      })
      .returning();

    const idempotencyKey = `confirm-${randomUUID()}`;
    const confirmation = {
      userId,
      scanId: scan!.id,
      idempotencyKey,
      confirmation: {
        selectedCandidateId: candidate!.id,
        artist: "Miles Davis",
        title: "Kind of Blue",
        releaseYear: 1959,
        label: "Columbia",
        catalogNumber: "CS 8163",
        barcode: null,
        releaseDate: "1959-08-17",
        country: "US",
        format: '12" Vinyl',
        packaging: "Cardboard/Paper Sleeve",
        releaseStatus: "Official",
        catalogReference: {
          provider: "musicbrainz" as const,
          releaseGroupId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          releaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          sourceUrl:
            "https://musicbrainz.org/release/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          fetchedAt: "2026-08-31T12:00:00.000Z",
        },
        list: "wishlist" as const,
        notes: null,
        copy: null,
      },
    };
    const created = await confirmScan(database.db, confirmation);
    const replayed = await confirmScan(database.db, confirmation);

    expect(created.created).toBe(true);
    expect(replayed.created).toBe(false);
    expect(replayed.record).toEqual(created.record);
    expect(created.record).toMatchObject({
      scanId: scan!.id,
      selectedCandidateId: candidate!.id,
      libraryItem: { list: "wishlist" },
      release: { artist: "Miles Davis", title: "Kind of Blue" },
    });

    const [secondScan] = await database.db
      .insert(scans)
      .values({
        userId,
        source: "single_upload",
        status: "identified",
        idempotencyKey: `confirm-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    await database.db.insert(scanAttempts).values({
      scanId: secondScan!.id,
      attemptNumber: 1,
      status: "succeeded",
      model: "integration-test-model",
      promptVersion: "integration-test.v1",
      providerResponseId: `response-${randomUUID()}`,
      durationMs: 20,
      completedAt: new Date(),
    });
    const converted = await confirmScan(database.db, {
      ...confirmation,
      scanId: secondScan!.id,
      idempotencyKey: `confirm-${randomUUID()}`,
      confirmation: {
        ...confirmation.confirmation,
        selectedCandidateId: null,
        artist: "MILES DAVIS",
        list: "collection",
        copy: {
          mediaCondition: "very_good_plus",
          sleeveCondition: "very_good",
          location: "Shelf A",
          notes: "First owned copy",
          acquiredAt: "2026-08-01",
        },
      },
    });
    const [thirdScan] = await database.db
      .insert(scans)
      .values({
        userId,
        source: "single_upload",
        status: "identified",
        idempotencyKey: `confirm-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    await database.db.insert(scanAttempts).values({
      scanId: thirdScan!.id,
      attemptNumber: 1,
      status: "succeeded",
      model: "integration-test-model",
      promptVersion: "integration-test.v1",
      providerResponseId: `response-${randomUUID()}`,
      durationMs: 20,
      completedAt: new Date(),
    });
    const secondCopy = await confirmScan(database.db, {
      ...confirmation,
      scanId: thirdScan!.id,
      idempotencyKey: `confirm-${randomUUID()}`,
      confirmation: {
        ...confirmation.confirmation,
        selectedCandidateId: null,
        artist: "MILES DAVIS",
        list: "collection",
        copy: {
          mediaCondition: null,
          sleeveCondition: null,
          location: "Shelf B",
          notes: null,
          acquiredAt: null,
        },
      },
    });

    expect(converted.record.release.id).toBe(created.record.release.id);
    expect(secondCopy.record.release.id).toBe(created.record.release.id);
    expect(secondCopy.record.libraryItem.id).toBe(
      created.record.libraryItem.id,
    );
    expect(converted.record.release.artist).toBe("MILES DAVIS");
    expect(converted.record.libraryItem).toMatchObject({
      id: created.record.libraryItem.id,
      list: "collection",
      copy: { location: "Shelf A" },
    });
    await expect(
      getScanForUser(database.db, { userId, scanId: secondScan!.id }),
    ).resolves.toMatchObject({
      confirmation: {
        release: { artist: "MILES DAVIS", title: "Kind of Blue" },
        libraryItem: { list: "collection" },
      },
    });
    await expect(
      listLibraryItemsForUser(database.db, { userId, list: "collection" }),
    ).resolves.toMatchObject({
      list: "collection",
      items: [
        {
          id: created.record.libraryItem.id,
          release: { artist: "MILES DAVIS", title: "Kind of Blue" },
          copyCount: 2,
          copies: [{ location: "Shelf A" }, { location: "Shelf B" }],
        },
      ],
    });
    expect(
      await database.db
        .select()
        .from(albums)
        .where(
          and(
            eq(albums.normalizedArtist, "miles davis"),
            eq(albums.normalizedTitle, "kind of blue"),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await database.db
        .select()
        .from(catalogReferences)
        .where(eq(catalogReferences.provider, "musicbrainz")),
    ).toHaveLength(2);
    expect(
      await database.db
        .select()
        .from(libraryCopies)
        .where(eq(libraryCopies.libraryItemId, created.record.libraryItem.id)),
    ).toHaveLength(2);
    expect(
      await database.db
        .select()
        .from(libraryItems)
        .where(eq(libraryItems.userId, userId)),
    ).toHaveLength(1);
    expect(
      await database.db
        .select()
        .from(scanConfirmations)
        .where(eq(scanConfirmations.userId, userId)),
    ).toHaveLength(3);

    await expect(
      confirmScan(database.db, {
        ...confirmation,
        confirmation: {
          ...confirmation.confirmation,
          title: "Different title",
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("direct library item management", () => {
  async function confirmWishlistItem(
    list: "collection" | "wishlist",
    release?: { artist?: string; title?: string },
  ) {
    const [scan] = await database.db
      .insert(scans)
      .values({
        userId,
        source: "single_upload",
        status: "identified",
        idempotencyKey: `confirm-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    await database.db.insert(scanAttempts).values({
      scanId: scan!.id,
      attemptNumber: 1,
      status: "succeeded",
      model: "integration-test-model",
      promptVersion: "integration-test.v1",
      providerResponseId: `response-${randomUUID()}`,
      durationMs: 20,
      completedAt: new Date(),
    });
    const result = await confirmScan(database.db, {
      userId,
      scanId: scan!.id,
      idempotencyKey: `confirm-${randomUUID()}`,
      confirmation: {
        selectedCandidateId: null,
        artist: release?.artist ?? `Library Management Test ${randomUUID()}`,
        title: release?.title ?? "Direct Update",
        releaseYear: 2001,
        label: null,
        catalogNumber: null,
        barcode: null,
        releaseDate: null,
        country: null,
        format: null,
        packaging: null,
        releaseStatus: null,
        catalogReference: null,
        list,
        notes: null,
        copy: null,
      },
    });
    return result.record.libraryItem.id;
  }

  it("converts a wishlist item to collection, creating one blank copy", async () => {
    const itemId = await confirmWishlistItem("wishlist");

    const updated = await updateLibraryItem(database.db, {
      userId,
      itemId,
      update: { list: "collection" },
    });

    expect(updated).toMatchObject({
      id: itemId,
      list: "collection",
      copyCount: 1,
    });
  });

  it("updates notes without changing list", async () => {
    const itemId = await confirmWishlistItem("wishlist");

    const updated = await updateLibraryItem(database.db, {
      userId,
      itemId,
      update: { notes: "Keep an eye out for a clean pressing" },
    });

    expect(updated).toMatchObject({
      id: itemId,
      list: "wishlist",
      notes: "Keep an eye out for a clean pressing",
    });
  });

  it("rejects moving a collection item with copies back to wishlist", async () => {
    const itemId = await confirmWishlistItem("collection");

    await expect(
      updateLibraryItem(database.db, {
        userId,
        itemId,
        update: { list: "wishlist" },
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("rejects updating a library item owned by another user", async () => {
    const itemId = await confirmWishlistItem("wishlist");

    await expect(
      updateLibraryItem(database.db, {
        userId: randomUUID(),
        itemId,
        update: { notes: "not mine" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("deletes an item with scan history while keeping its confirmation audit row", async () => {
    const itemId = await confirmWishlistItem("collection");
    const [confirmationBefore] = await database.db
      .select()
      .from(scanConfirmations)
      .where(eq(scanConfirmations.libraryItemId, itemId));
    expect(confirmationBefore).toBeDefined();
    const scanId = confirmationBefore!.scanId;

    const deleted = await deleteLibraryItem(database.db, { userId, itemId });
    expect(deleted).toEqual({ id: itemId });
    expect(
      await database.db
        .select()
        .from(libraryItems)
        .where(eq(libraryItems.id, itemId)),
    ).toHaveLength(0);

    // The decision survives with its reviewed snapshot; only the pointer to the
    // removed item is cleared (ADR-0018).
    const [confirmationAfter] = await database.db
      .select()
      .from(scanConfirmations)
      .where(eq(scanConfirmations.scanId, scanId));
    expect(confirmationAfter).toMatchObject({
      scanId,
      libraryItemId: null,
    });
    expect(confirmationAfter!.reviewedRelease).toMatchObject({
      title: "Direct Update",
    });

    // The scan reads as reviewable again, so the record can be saved anew.
    expect(
      await getScanConfirmationForUser(database.db, { userId, scanId }),
    ).toBeNull();
  });

  it("deletes a library item with no confirmation history and cascades its copies", async () => {
    const [album] = await database.db
      .insert(albums)
      .values({
        artist: `Directly Added Artist ${randomUUID()}`,
        title: "Directly Added Title",
        normalizedArtist: `directly added artist ${randomUUID()}`,
        normalizedTitle: "directly added title",
      })
      .returning();
    const [directRelease] = await database.db
      .insert(releases)
      .values({
        albumId: album!.id,
        identityKey: randomUUID().replace(/-/g, "").padEnd(64, "0"),
      })
      .returning();
    const [item] = await database.db
      .insert(libraryItems)
      .values({
        userId,
        releaseId: directRelease!.id,
        list: "wishlist",
      })
      .returning();

    const deleted = await deleteLibraryItem(database.db, {
      userId,
      itemId: item!.id,
    });
    expect(deleted).toEqual({ id: item!.id });

    await expect(
      deleteLibraryItem(database.db, { userId, itemId: item!.id }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("saves a scan again after its item was removed, replacing the old decision", async () => {
    const itemId = await confirmWishlistItem("wishlist");
    const [confirmation] = await database.db
      .select()
      .from(scanConfirmations)
      .where(eq(scanConfirmations.libraryItemId, itemId));
    const scanId = confirmation!.scanId;
    await deleteLibraryItem(database.db, { userId, itemId });

    const resaved = await confirmScan(database.db, {
      userId,
      scanId,
      idempotencyKey: `confirm-again-${randomUUID()}`,
      confirmation: {
        selectedCandidateId: null,
        artist: "Resaved Artist",
        title: "Resaved Title",
        releaseYear: 1999,
        label: null,
        catalogNumber: null,
        barcode: null,
        releaseDate: null,
        country: null,
        format: null,
        packaging: null,
        releaseStatus: null,
        catalogReference: null,
        list: "collection",
        notes: null,
        copy: null,
      },
    });

    expect(resaved.created).toBe(true);
    expect(resaved.record.libraryItem.id).not.toBe(itemId);
    expect(resaved.record.libraryItem.list).toBe("collection");
  });

  it("exposes the confirming scan's first completed image as the item cover", async () => {
    const [scan] = await database.db
      .insert(scans)
      .values({
        userId,
        source: "single_upload",
        status: "identified",
        idempotencyKey: `cover-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    await database.db.insert(scanAttempts).values({
      scanId: scan!.id,
      attemptNumber: 1,
      status: "succeeded",
      model: "integration-test-model",
      promptVersion: "integration-test.v1",
      providerResponseId: `response-${randomUUID()}`,
      durationMs: 20,
      completedAt: new Date(),
    });
    const [cover] = await database.db
      .insert(imageAssets)
      .values({
        scanId: scan!.id,
        idempotencyKey: `cover-image-${randomUUID()}`,
        objectKey: `${userId}/${scan!.id}/${randomUUID()}`,
        filename: "front.jpg",
        viewType: "front",
        mimeType: "image/jpeg",
        sizeBytes: 1_024,
        checksumSha256: "d".repeat(64),
        completedAt: new Date(),
        width: 800,
        height: 800,
        analysisSizeBytes: 200,
        analysisWidth: 800,
        analysisHeight: 800,
        thumbnailSizeBytes: 40,
      })
      .returning();

    const confirmed = await confirmScan(database.db, {
      userId,
      scanId: scan!.id,
      idempotencyKey: `cover-confirm-${randomUUID()}`,
      confirmation: {
        selectedCandidateId: null,
        artist: `Cover Art Test ${randomUUID()}`,
        title: "Has A Cover",
        releaseYear: 1971,
        label: null,
        catalogNumber: null,
        barcode: null,
        releaseDate: null,
        country: null,
        format: null,
        packaging: null,
        releaseStatus: null,
        catalogReference: null,
        list: "collection",
        notes: null,
        copy: null,
      },
    });

    const item = await getLibraryItemForUser(database.db, {
      userId,
      itemId: confirmed.record.libraryItem.id,
    });
    expect(item.coverImage).toEqual({
      scanId: scan!.id,
      imageId: cover!.id,
    });

    await expect(
      getLibraryItemForUser(database.db, { userId, itemId: randomUUID() }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("searches by displayed artist/title and sorts the results", async () => {
    const suffix = randomUUID();
    const milesId = await confirmWishlistItem("wishlist", {
      artist: `Miles Davis Search Test ${suffix}`,
      title: "Kind of Blue",
    });
    const johnId = await confirmWishlistItem("wishlist", {
      artist: `John Coltrane Search Test ${suffix}`,
      title: `A Love Supreme ${suffix}`,
    });

    const matched = await listLibraryItemsForUser(database.db, {
      userId,
      list: "wishlist",
      query: `miles davis search test ${suffix}`,
    });
    expect(matched.items.map((item) => item.id)).toEqual([milesId]);

    const byTitle = await listLibraryItemsForUser(database.db, {
      userId,
      list: "wishlist",
      query: `love supreme ${suffix}`,
    });
    expect(byTitle.items.map((item) => item.id)).toEqual([johnId]);

    const sortedByArtist = await listLibraryItemsForUser(database.db, {
      userId,
      list: "wishlist",
      query: `search test ${suffix}`,
      sort: "artist",
    });
    expect(sortedByArtist.items.map((item) => item.id)).toEqual([
      johnId,
      milesId,
    ]);

    const noMatches = await listLibraryItemsForUser(database.db, {
      userId,
      list: "wishlist",
      query: `no such artist ${suffix}`,
    });
    expect(noMatches.items).toEqual([]);
  });
});

describe("batch grouping and scan lifecycle", () => {
  it("groups independent scans under one batch and projects their status", async () => {
    const batch = await createOrGetBatch(database.db, {
      userId,
      idempotencyKey: `batch-${randomUUID()}`,
    });
    const replayedBatch = await createOrGetBatch(database.db, {
      userId,
      idempotencyKey: batch.record.idempotencyKey,
    });
    expect(batch.created).toBe(true);
    expect(replayedBatch.created).toBe(false);
    expect(replayedBatch.record.id).toBe(batch.record.id);

    const first = await createOrGetScan(database.db, {
      userId,
      source: "single_upload",
      idempotencyKey: `batch-scan-1-${randomUUID()}`,
      batchId: batch.record.id,
    });
    const second = await createOrGetScan(database.db, {
      userId,
      source: "single_upload",
      idempotencyKey: `batch-scan-2-${randomUUID()}`,
      batchId: batch.record.id,
    });
    expect(first.record.batchId).toBe(batch.record.id);
    expect(second.record.batchId).toBe(batch.record.id);

    const { batch: loadedBatch, scanIds } = await getBatchForUser(database.db, {
      userId,
      batchId: batch.record.id,
    });
    expect(loadedBatch.id).toBe(batch.record.id);
    expect(scanIds).toEqual([first.record.id, second.record.id]);

    const summaries = await listScanSummariesForUser(database.db, {
      userId,
      scanIds,
    });
    expect(summaries.map((summary) => summary.status)).toEqual([
      "awaiting_upload",
      "awaiting_upload",
    ]);

    await expect(
      createOrGetScan(database.db, {
        userId,
        source: "single_upload",
        idempotencyKey: `batch-scan-missing-${randomUUID()}`,
        batchId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("enforces the server-side batch limit while allowing idempotent replay", async () => {
    const batch = await createOrGetBatch(database.db, {
      userId,
      idempotencyKey: `limited-batch-${randomUUID()}`,
    });
    const scanKeys = Array.from(
      { length: MAX_SCANS_PER_BATCH },
      (_, index) => `limited-batch-scan-${index}-${randomUUID()}`,
    );

    for (const idempotencyKey of scanKeys) {
      await createOrGetScan(database.db, {
        userId,
        source: "batch_upload",
        idempotencyKey,
        batchId: batch.record.id,
      });
    }

    await expect(
      createOrGetScan(database.db, {
        userId,
        source: "batch_upload",
        idempotencyKey: scanKeys[0]!,
        batchId: batch.record.id,
      }),
    ).resolves.toMatchObject({ created: false });
    await expect(
      createOrGetScan(database.db, {
        userId,
        source: "batch_upload",
        idempotencyKey: `over-limit-${randomUUID()}`,
        batchId: batch.record.id,
      }),
    ).rejects.toMatchObject({ code: "batch_scan_limit" });
  });

  it("falls back to the original object for images completed before normalization", async () => {
    const scan = await createOrGetScan(database.db, {
      userId,
      source: "single_upload",
      idempotencyKey: `legacy-scan-${randomUUID()}`,
    });
    const upload = await createOrGetImageUpload(database.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey: `legacy-upload-${randomUUID()}`,
      filename: "legacy-front.png",
      mimeType: "image/png",
      sizeBytes: 512,
      checksumSha256: "9".repeat(64),
      maxImages: 12,
    });
    await database.db
      .update(imageAssets)
      .set({ completedAt: new Date(), width: 800, height: 600 })
      .where(eq(imageAssets.id, upload.record.id));
    const submitted = await submitScan(database.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey: `legacy-submit-${randomUUID()}`,
    });

    const prepared = await prepareScanAnalysis(database.db, {
      job: submitted.job,
      deliveryAttempt: 1,
      model: "integration-test-model",
      promptVersion: "integration-test.v1",
    });

    expect(prepared).toMatchObject({
      status: "ready",
      images: [
        {
          objectKey: upload.record.objectKey,
          mimeType: "image/png",
          sizeBytes: 512,
        },
      ],
    });
  });

  it("aggregates token usage and estimated cost across a batch and account usage window", async () => {
    const usageUserId = randomUUID();
    await database.db.insert(users).values({ id: usageUserId });

    const batch = await createOrGetBatch(database.db, {
      userId: usageUserId,
      idempotencyKey: `usage-batch-${randomUUID()}`,
    });
    const succeededScan = await createOrGetScan(database.db, {
      userId: usageUserId,
      source: "single_upload",
      idempotencyKey: `usage-scan-succeeded-${randomUUID()}`,
      batchId: batch.record.id,
    });
    const failedScan = await createOrGetScan(database.db, {
      userId: usageUserId,
      source: "single_upload",
      idempotencyKey: `usage-scan-failed-${randomUUID()}`,
      batchId: batch.record.id,
    });
    const otherScan = await createOrGetScan(database.db, {
      userId: usageUserId,
      source: "single_upload",
      idempotencyKey: `usage-scan-other-${randomUUID()}`,
    });

    await database.db
      .update(scans)
      .set({ status: "identified", completedAt: new Date() })
      .where(eq(scans.id, succeededScan.record.id));
    await database.db.insert(scanAttempts).values({
      scanId: succeededScan.record.id,
      attemptNumber: 1,
      status: "succeeded",
      model: "gpt-5.6-sol",
      promptVersion: "integration-test.v1",
      providerResponseId: `response-${randomUUID()}`,
      inputTokens: 1_000,
      outputTokens: 200,
      totalTokens: 1_200,
      durationMs: 8_000,
      completedAt: new Date(),
    });

    await database.db
      .update(scans)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(scans.id, failedScan.record.id));
    await database.db.insert(scanAttempts).values({
      scanId: failedScan.record.id,
      attemptNumber: 1,
      status: "failed",
      model: "gpt-5.6-sol",
      promptVersion: "integration-test.v1",
      errorCategory: "unknown",
      errorMessage: "synthetic failure",
      durationMs: 500,
      completedAt: new Date(),
    });

    await database.db
      .update(scans)
      .set({ status: "identified", completedAt: new Date() })
      .where(eq(scans.id, otherScan.record.id));
    await database.db.insert(scanAttempts).values({
      scanId: otherScan.record.id,
      attemptNumber: 1,
      status: "succeeded",
      model: "gpt-5.6-sol",
      promptVersion: "integration-test.v1",
      providerResponseId: `response-${randomUUID()}`,
      inputTokens: 500,
      outputTokens: 100,
      totalTokens: 600,
      durationMs: 6_000,
      completedAt: new Date(),
    });

    const batchCost = await getBatchCostSummary(database.db, {
      batchId: batch.record.id,
      scanIds: [succeededScan.record.id, failedScan.record.id],
    });
    expect(batchCost).toMatchObject({
      attemptCount: 1,
      totalInputTokens: 1_000,
      totalOutputTokens: 200,
      totalTokens: 1_200,
      averageDurationMs: 8_000,
    });
    expect(batchCost.estimatedCostUsd).toBeCloseTo(
      (1_000 * 4 + 200 * 20) / 1_000_000,
      10,
    );

    const usage = await getUsageSummaryForUser(database.db, {
      userId: usageUserId,
      since: new Date(Date.now() - 24 * 60 * 60 * 1_000),
    });
    expect(usage.scanCount).toBe(3);
    expect(usage.outcomes).toMatchObject({
      identified: 2,
      failed: 1,
    });
    expect(usage.cost).toMatchObject({
      attemptCount: 2,
      totalInputTokens: 1_500,
      totalOutputTokens: 300,
      totalTokens: 1_800,
    });
    expect(usage.cost.estimatedCostUsd).toBeCloseTo(
      (1_500 * 4 + 300 * 20) / 1_000_000,
      10,
    );

    await database.db.delete(users).where(eq(users.id, usageUserId));
  });

  it("retries a failed scan as a new attempt and rejects retrying an active scan", async () => {
    const scan = await createOrGetScan(database.db, {
      userId,
      source: "single_upload",
      idempotencyKey: `retry-scan-${randomUUID()}`,
    });
    const upload = await createOrGetImageUpload(database.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey: `retry-upload-${randomUUID()}`,
      filename: "front.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 512,
      checksumSha256: "e".repeat(64),
      maxImages: 12,
    });
    await completeImageUpload(database.db, {
      userId,
      scanId: scan.record.id,
      imageId: upload.record.id,
      width: 800,
      height: 800,
      analysisSizeBytes: 200,
      analysisWidth: 800,
      analysisHeight: 800,
      thumbnailSizeBytes: 40,
    });

    await expect(
      retryScan(database.db, { userId, scanId: scan.record.id }),
    ).rejects.toMatchObject({ code: "invalid_state" });

    await database.db
      .update(scans)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(scans.id, scan.record.id));
    await database.db.insert(scanAttempts).values({
      scanId: scan.record.id,
      attemptNumber: 1,
      status: "failed",
      model: "integration-test-model",
      promptVersion: "integration-test.v1",
      errorCategory: "unknown",
      errorMessage: "synthetic failure",
      durationMs: 10,
      completedAt: new Date(),
    });

    const retried = await retryScan(database.db, {
      userId,
      scanId: scan.record.id,
    });
    expect(retried.created).toBe(true);
    expect(retried.job.attemptNumber).toBe(2);
    expect(retried.record.status).toBe("queued");

    const replayedRetry = await retryScan(database.db, {
      userId,
      scanId: scan.record.id,
    });
    expect(replayedRetry.created).toBe(false);
    expect(replayedRetry.jobId).toBe(retried.jobId);
  });

  it("cancels a queued scan and skips its outbox dispatch", async () => {
    const scan = await createOrGetScan(database.db, {
      userId,
      source: "single_upload",
      idempotencyKey: `cancel-scan-${randomUUID()}`,
    });
    const upload = await createOrGetImageUpload(database.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey: `cancel-upload-${randomUUID()}`,
      filename: "front.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 512,
      checksumSha256: "f".repeat(64),
      maxImages: 12,
    });
    await completeImageUpload(database.db, {
      userId,
      scanId: scan.record.id,
      imageId: upload.record.id,
      width: 800,
      height: 800,
      analysisSizeBytes: 200,
      analysisWidth: 800,
      analysisHeight: 800,
      thumbnailSizeBytes: 40,
    });
    const submitted = await submitScan(database.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey: `cancel-submit-${randomUUID()}`,
    });

    const canceled = await cancelScan(database.db, {
      userId,
      scanId: scan.record.id,
    });
    expect(canceled.created).toBe(true);
    expect(canceled.record.status).toBe("canceled");

    const replayedCancel = await cancelScan(database.db, {
      userId,
      scanId: scan.record.id,
    });
    expect(replayedCancel.created).toBe(false);
    expect(replayedCancel.record.status).toBe("canceled");

    const dispatch = await dispatchUntil(submitted.jobId, async () => {
      throw new Error("must not publish a canceled scan's job");
    });
    expect(dispatch).toMatchObject({
      status: "canceled",
      jobId: submitted.jobId,
    });

    await expect(
      cancelScan(database.db, { userId, scanId: scan.record.id }),
    ).resolves.toMatchObject({ created: false });
  });

  it("dismisses a reviewable scan result idempotently", async () => {
    const [scan] = await database.db
      .insert(scans)
      .values({
        userId,
        source: "single_upload",
        status: "needs_review",
        idempotencyKey: `dismiss-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    await database.db.insert(scanAttempts).values({
      scanId: scan!.id,
      attemptNumber: 1,
      status: "succeeded",
      model: "integration-test-model",
      promptVersion: "integration-test.v1",
      providerResponseId: `response-${randomUUID()}`,
      durationMs: 15,
      completedAt: new Date(),
    });

    const summariesBeforeDismiss = await listScanSummariesForUser(database.db, {
      userId,
      scanIds: [scan!.id],
    });
    expect(summariesBeforeDismiss[0]).toMatchObject({
      status: "needs_review",
      confirmedList: null,
    });

    const dismissed = await cancelScan(database.db, {
      userId,
      scanId: scan!.id,
    });
    expect(dismissed.created).toBe(true);
    expect(dismissed.record.status).toBe("canceled");

    const replayedDismiss = await cancelScan(database.db, {
      userId,
      scanId: scan!.id,
    });
    expect(replayedDismiss.created).toBe(false);
    expect(replayedDismiss.record.status).toBe("canceled");
  });

  it("rejects dismissing a scan that has already been confirmed", async () => {
    const [scan] = await database.db
      .insert(scans)
      .values({
        userId,
        source: "single_upload",
        status: "identified",
        idempotencyKey: `dismiss-confirmed-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    const [attempt] = await database.db
      .insert(scanAttempts)
      .values({
        scanId: scan!.id,
        attemptNumber: 1,
        status: "succeeded",
        model: "integration-test-model",
        promptVersion: "integration-test.v1",
        providerResponseId: `response-${randomUUID()}`,
        durationMs: 15,
        completedAt: new Date(),
      })
      .returning();
    const [candidate] = await database.db
      .insert(scanCandidates)
      .values({
        scanAttemptId: attempt!.id,
        rank: 1,
        artist: "Dismiss Guard Test",
        title: "Kept Album",
        releaseYear: 2000,
        label: null,
        catalogNumber: null,
        barcode: null,
        confidence: 0.95,
        evidence: [],
        warnings: [],
      })
      .returning();

    await confirmScan(database.db, {
      userId,
      scanId: scan!.id,
      idempotencyKey: `dismiss-confirm-${randomUUID()}`,
      confirmation: {
        selectedCandidateId: candidate!.id,
        artist: "Dismiss Guard Test",
        title: "Kept Album",
        releaseYear: 2000,
        label: null,
        catalogNumber: null,
        barcode: null,
        releaseDate: null,
        country: null,
        format: null,
        packaging: null,
        releaseStatus: null,
        catalogReference: null,
        list: "wishlist",
        notes: null,
        copy: null,
      },
    });

    const summaries = await listScanSummariesForUser(database.db, {
      userId,
      scanIds: [scan!.id],
    });
    expect(summaries[0]).toMatchObject({ confirmedList: "wishlist" });

    await expect(
      cancelScan(database.db, { userId, scanId: scan!.id }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });
});

describe("Clerk user identity resolution", () => {
  it("provisions a new user on first lookup and reuses it thereafter", async () => {
    const clerkUserId = `user_${randomUUID()}`;

    const provisionedId = await getOrCreateUserIdByClerkId(
      database.db,
      clerkUserId,
    );
    const reusedId = await getOrCreateUserIdByClerkId(database.db, clerkUserId);

    expect(reusedId).toBe(provisionedId);

    await database.db.delete(users).where(eq(users.id, provisionedId));
  });

  it("resolves concurrent lookups for the same Clerk identity to one user", async () => {
    const clerkUserId = `user_${randomUUID()}`;

    const [first, second] = await Promise.all([
      getOrCreateUserIdByClerkId(database.db, clerkUserId),
      getOrCreateUserIdByClerkId(database.db, clerkUserId),
    ]);

    expect(second).toBe(first);

    await database.db.delete(users).where(eq(users.id, first));
  });
});

describe("account export and deletion", () => {
  async function createAccountWithData() {
    const [account] = await database.db.insert(users).values({}).returning();
    const accountId = account!.id;

    const [scan] = await database.db
      .insert(scans)
      .values({
        userId: accountId,
        source: "single_upload",
        status: "identified",
        idempotencyKey: `account-export-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    await database.db.insert(imageAssets).values({
      scanId: scan!.id,
      idempotencyKey: `account-export-image-${randomUUID()}`,
      objectKey: `${accountId}/${scan!.id}/${randomUUID()}/original`,
      filename: "front.jpg",
      viewType: "front",
      mimeType: "image/jpeg",
      sizeBytes: 1_024,
      checksumSha256: "d".repeat(64),
      completedAt: new Date(),
      width: 800,
      height: 800,
      analysisSizeBytes: 200,
      analysisWidth: 800,
      analysisHeight: 800,
      thumbnailSizeBytes: 40,
    });
    await database.db.insert(scanAttempts).values({
      scanId: scan!.id,
      attemptNumber: 1,
      status: "succeeded",
      model: "integration-test-model",
      promptVersion: "integration-test.v1",
      providerResponseId: `response-${randomUUID()}`,
      durationMs: 20,
      completedAt: new Date(),
    });
    const confirmation = await confirmScan(database.db, {
      userId: accountId,
      scanId: scan!.id,
      idempotencyKey: `account-export-confirm-${randomUUID()}`,
      confirmation: {
        selectedCandidateId: null,
        artist: `Account Export Test ${randomUUID()}`,
        title: "Account Deletion",
        releaseYear: 2001,
        label: null,
        catalogNumber: null,
        barcode: null,
        releaseDate: null,
        country: null,
        format: null,
        packaging: null,
        releaseStatus: null,
        catalogReference: null,
        list: "collection",
        notes: null,
        copy: null,
      },
    });

    return { accountId, scanId: scan!.id, confirmation };
  }

  it("exports every row the account owns", async () => {
    const { accountId, scanId, confirmation } = await createAccountWithData();

    const exported = await getAccountExportForUser(database.db, {
      userId: accountId,
    });

    expect(exported.account.id).toBe(accountId);
    expect(exported.scans).toHaveLength(1);
    expect(exported.scans[0]).toMatchObject({ id: scanId });
    expect(exported.images).toHaveLength(1);
    expect(exported.attempts).toHaveLength(1);
    expect(exported.confirmations).toHaveLength(1);
    expect(exported.confirmations[0]).toMatchObject({
      scanId,
      libraryItemId: confirmation.record.libraryItem.id,
    });
    expect(exported.libraryItems).toHaveLength(1);
    expect(exported.libraryCopies).toHaveLength(1);

    await deleteAccount(database.db, { userId: accountId });
  });

  it("rejects exporting an account that does not exist", async () => {
    await expect(
      getAccountExportForUser(database.db, { userId: randomUUID() }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("deletes an account with confirmation history despite the restrict FKs, without touching shared catalog rows", async () => {
    const { accountId, scanId } = await createAccountWithData();
    const [libraryItemBeforeDelete] = await database.db
      .select({ releaseId: libraryItems.releaseId })
      .from(libraryItems)
      .where(eq(libraryItems.userId, accountId));
    const releaseId = libraryItemBeforeDelete!.releaseId;

    const deleted = await deleteAccount(database.db, { userId: accountId });

    expect(deleted.id).toBe(accountId);
    expect(deleted.objectKeys.length).toBeGreaterThan(0);
    expect(
      await database.db.select().from(users).where(eq(users.id, accountId)),
    ).toHaveLength(0);
    expect(
      await database.db.select().from(scans).where(eq(scans.id, scanId)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(scanConfirmations)
        .where(eq(scanConfirmations.scanId, scanId)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(libraryItems)
        .where(eq(libraryItems.userId, accountId)),
    ).toHaveLength(0);
    // The shared release/album rows must survive the account's deletion.
    expect(
      await database.db
        .select()
        .from(releases)
        .where(eq(releases.id, releaseId)),
    ).toHaveLength(1);
  });

  it("rejects deleting an account that does not exist", async () => {
    await expect(
      deleteAccount(database.db, { userId: randomUUID() }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
