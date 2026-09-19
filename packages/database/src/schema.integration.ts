import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ANALYZE_SCAN_JOB,
  CONFIRMATION_COMPLETED_EVENT_CONTRACT,
  MAX_LIBRARY_COPIES_PER_ITEM,
  MAX_PLAYLIST_ENTRIES,
  MAX_PLAYLISTS_PER_USER,
  MAX_SCANS_PER_BATCH,
  SCAN_CONFIRMED_EVENT,
  SCAN_CONFIRMED_EVENT_CONTRACT,
  type AnalyzeScanJob,
  type LibraryItemResult,
} from "@vinylhound/contracts";

import { createDatabase } from "./database.ts";
import {
  deleteAccount,
  getAccountExportForUser,
} from "./account-repository.ts";
import {
  getBatchCostSummary,
  getScanForUser,
  getUsageSummaryForUser,
  listScanSummariesForUser,
  prepareScanAnalysis,
} from "./analysis-repository.ts";
import {
  applyConfirmationCompletion,
  confirmScan,
  confirmationEventId,
  getScanConfirmationForUser,
} from "./confirmation-repository.ts";
import { dispatchNextConfirmationReceipt } from "./confirmation-receipt-repository.ts";
import { processScanConfirmation } from "./confirmation-processing-repository.ts";
import {
  createLibraryCopy,
  deleteLibraryCopy,
  deleteLibraryItem,
  getLibraryItemForUser,
  iterateLibraryItemsForUser,
  listFavoriteLibraryItemsForUser,
  listLibraryItemsForUser,
  updateLibraryCopy,
  updateLibraryItem,
} from "./library-repository.ts";
import { dispatchNextOutboxMessage } from "./outbox-repository.ts";
import { placeLibraryRelease } from "./placement-repository.ts";
import {
  addPlaylistEntry,
  createPlaylist,
  deletePlaylist,
  getPlaylistForUser,
  listPlaylistsForUser,
  removePlaylistEntry,
  updatePlaylist,
} from "./playlist-repository.ts";
import {
  cancelScan,
  cleanupAbandonedScans,
  completeImageUpload,
  createOrGetBatch,
  createOrGetImageUpload,
  createOrGetScan,
  getBatchForUser,
  getOrCreateUserIdByClerkId,
  getScanQuotaHeadroomForUser,
  retryScan,
  submitScan,
} from "./scan-repository.ts";
import {
  albums,
  catalogReferences,
  confirmationReceipts,
  imageAssets,
  libraryCopies,
  libraryItems,
  outboxMessages,
  playlistEntries,
  playlists,
  releases,
  scanAttempts,
  scanCandidates,
  scanConfirmations,
  scans,
  users,
} from "./schema.ts";

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
      {
        [ANALYZE_SCAN_JOB]: async (payload, idempotencyKey) => {
          if (idempotencyKey === targetJobId) {
            await publishTarget(payload as AnalyzeScanJob);
          }
        },
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

/**
 * P4.2 Task 3 (ADR-0028): `confirmScan` alone only ever returns a `pending`
 * record now -- the release/library write moved to a separate "core"
 * transaction (`processScanConfirmation`) reached through a
 * `scan.confirmed.v1` event, and the result only reaches `scan_confirmations`
 * once a `confirmation.completed.v1` event is applied
 * (`applyConfirmationCompletion`). Existing call sites in this file want the
 * finished record, not the pipeline's intermediate state, so this helper
 * drives all three hops directly -- reading the durable rows each hop leaves
 * behind rather than going through a real queue -- and returns the same
 * shape `confirmScan` itself used to return synchronously before this task.
 */
async function confirmScanAndComplete(
  input: Parameters<typeof confirmScan>[1],
): ReturnType<typeof confirmScan> {
  const result = await confirmScan(database.db, input);
  if (result.record.status === "completed") {
    return result;
  }

  // Both tables key on `confirmationEventId(scanId, idempotencyKey)`, not
  // scanId alone (ADR-0018 lets one scan be confirmed, completed, removed,
  // and reconfirmed more than once), so filtering on the exact composite key
  // finds this specific attempt's row even if the scan has older ones.
  const eventKey = confirmationEventId(input.scanId, input.idempotencyKey);
  const [outboxRow] = await database.db
    .select()
    .from(outboxMessages)
    .where(
      and(
        eq(outboxMessages.topic, SCAN_CONFIRMED_EVENT),
        eq(outboxMessages.idempotencyKey, eventKey),
      ),
    )
    .limit(1);
  if (!outboxRow) {
    throw new Error(
      `No scan.confirmed.v1 outbox row was recorded for scan ${input.scanId}.`,
    );
  }
  const confirmedEvent = SCAN_CONFIRMED_EVENT_CONTRACT.consumerSchema.parse(
    outboxRow.payload,
  );
  await processScanConfirmation(database.db, confirmedEvent);

  const [receipt] = await database.db
    .select()
    .from(confirmationReceipts)
    .where(eq(confirmationReceipts.idempotencyKey, eventKey))
    .limit(1);
  if (!receipt) {
    throw new Error(
      `No confirmation_receipts row was recorded for scan ${input.scanId}.`,
    );
  }
  const completedEvent =
    CONFIRMATION_COMPLETED_EVENT_CONTRACT.consumerSchema.parse(receipt.payload);
  await applyConfirmationCompletion(database.db, completedEvent);

  const final = await confirmScan(database.db, input);
  return { record: final.record, created: result.created };
}

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
      {
        [ANALYZE_SCAN_JOB]: async () => {
          throw new Error("synthetic Redis outage");
        },
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
      {
        [ANALYZE_SCAN_JOB]: async (payload, jobId) => {
          const job = payload as AnalyzeScanJob;
          publishedJobs.push({ jobId, scanId: job.scanId });
        },
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
    const created = await confirmScanAndComplete(confirmation);
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
    const converted = await confirmScanAndComplete({
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
    const secondCopy = await confirmScanAndComplete({
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

    expect(converted.record.release!.id).toBe(created.record.release!.id);
    expect(secondCopy.record.release!.id).toBe(created.record.release!.id);
    expect(secondCopy.record.libraryItem!.id).toBe(
      created.record.libraryItem!.id,
    );
    expect(converted.record.release!.artist).toBe("MILES DAVIS");
    expect(converted.record.libraryItem!).toMatchObject({
      id: created.record.libraryItem!.id,
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
          id: created.record.libraryItem!.id,
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
        .where(eq(libraryCopies.libraryItemId, created.record.libraryItem!.id)),
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
    const result = await confirmScanAndComplete({
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
    return result.record.libraryItem!.id;
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

    const resaved = await confirmScanAndComplete({
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
    expect(resaved.record.libraryItem!.id).not.toBe(itemId);
    expect(resaved.record.libraryItem!.list).toBe("collection");
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

    const confirmed = await confirmScanAndComplete({
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
      itemId: confirmed.record.libraryItem!.id,
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

describe("per-copy editing and last-copy rules", () => {
  const blankCopy = {
    mediaCondition: null,
    sleeveCondition: null,
    location: null,
    notes: null,
    acquiredAt: null,
  };

  /** Confirms a scan into the collection, which records the first copy. */
  async function confirmOwnedRecord(owner = userId) {
    const [scan] = await database.db
      .insert(scans)
      .values({
        userId: owner,
        source: "single_upload",
        status: "identified",
        idempotencyKey: `copy-scan-${randomUUID()}`,
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
    const result = await confirmScanAndComplete({
      userId: owner,
      scanId: scan!.id,
      idempotencyKey: `copy-confirm-${randomUUID()}`,
      confirmation: {
        selectedCandidateId: null,
        artist: `Copy Rules Artist ${randomUUID()}`,
        title: "Copy Rules Title",
        releaseYear: 1977,
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
    return {
      scanId: scan!.id,
      itemId: result.record.libraryItem!.id,
      copyId: result.record.libraryItem!.copy!.id,
    };
  }

  it("edits every copy field, converges when replayed, and reads back through the record", async () => {
    const { itemId, copyId } = await confirmOwnedRecord();
    const before = await getLibraryItemForUser(database.db, {
      userId,
      itemId,
    });
    const update = {
      mediaCondition: "very_good_plus" as const,
      sleeveCondition: "very_good" as const,
      location: "Shelf B",
      notes: "Insert included",
      acquiredAt: "2026-08-30",
    };

    const edited = await updateLibraryCopy(database.db, {
      userId,
      itemId,
      copyId,
      update,
    });
    expect(edited).toMatchObject({ id: copyId, ...update });

    // Idempotent by identity: the same body again changes nothing.
    const replayed = await updateLibraryCopy(database.db, {
      userId,
      itemId,
      copyId,
      update,
    });
    expect(replayed).toMatchObject({ id: copyId, ...update });

    // A partial update touches only the named field.
    const cleared = await updateLibraryCopy(database.db, {
      userId,
      itemId,
      copyId,
      update: { location: null },
    });
    expect(cleared).toMatchObject({ ...update, location: null });

    const after = await getLibraryItemForUser(database.db, { userId, itemId });
    expect(after.copies).toHaveLength(1);
    expect(after.copies[0]).toMatchObject({ ...update, location: null });
    expect(after.copyCount).toBe(1);
    // The record surfaces under `recent` when its inventory changes.
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThan(
      new Date(before.updatedAt).getTime(),
    );
  });

  it("rejects editing or removing a copy the caller does not own, or through another record", async () => {
    const mine = await confirmOwnedRecord();
    const other = await confirmOwnedRecord();
    const strangerId = randomUUID();
    await database.db.insert(users).values({ id: strangerId });
    const stranger = await confirmOwnedRecord(strangerId);

    // Another user's copy, named with its own record: not found, unchanged.
    await expect(
      updateLibraryCopy(database.db, {
        userId,
        itemId: stranger.itemId,
        copyId: stranger.copyId,
        update: { location: "Not mine" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      deleteLibraryCopy(database.db, {
        userId,
        itemId: stranger.itemId,
        copyId: stranger.copyId,
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    // My own copy addressed through a different record of mine: the copy
    // belongs to exactly one record, so the pair does not resolve.
    await expect(
      updateLibraryCopy(database.db, {
        userId,
        itemId: other.itemId,
        copyId: mine.copyId,
        update: { location: "Wrong record" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      deleteLibraryCopy(database.db, {
        userId,
        itemId: other.itemId,
        copyId: mine.copyId,
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    // A stranger addressing my record and copy correctly still gets nothing.
    await expect(
      createLibraryCopy(database.db, {
        userId: strangerId,
        itemId: mine.itemId,
        idempotencyKey: `stranger-${randomUUID()}`,
        copy: blankCopy,
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    const [untouched] = await database.db
      .select()
      .from(libraryCopies)
      .where(eq(libraryCopies.id, stranger.copyId));
    expect(untouched).toMatchObject({ id: stranger.copyId, location: null });
    expect(
      (
        await getLibraryItemForUser(database.db, {
          userId,
          itemId: mine.itemId,
        })
      ).copies,
    ).toHaveLength(1);
    await database.db.delete(users).where(eq(users.id, strangerId));
  });

  it("removes a copy while its confirmation keeps every audit field", async () => {
    const { scanId, itemId, copyId } = await confirmOwnedRecord();
    const [before] = await database.db
      .select()
      .from(scanConfirmations)
      .where(eq(scanConfirmations.scanId, scanId));
    expect(before).toMatchObject({ libraryItemId: itemId, copyId });

    expect(
      await deleteLibraryCopy(database.db, { userId, itemId, copyId }),
    ).toEqual({ id: copyId });

    // The decision survives intact; only the pointer to the removed copy
    // clears, and the scan still reads as confirmed into this record.
    const [after] = await database.db
      .select()
      .from(scanConfirmations)
      .where(eq(scanConfirmations.scanId, scanId));
    expect(after).toMatchObject({
      scanId,
      libraryItemId: itemId,
      copyId: null,
      releaseId: before!.releaseId,
      selectedCandidateId: before!.selectedCandidateId,
      confirmedAt: before!.confirmedAt,
    });
    expect(after!.reviewedRelease).toEqual(before!.reviewedRelease);
    const summary = await getScanConfirmationForUser(database.db, {
      userId,
      scanId,
    });
    expect(summary).toMatchObject({
      libraryItem: { id: itemId, list: "collection", copy: null },
    });

    // Removing it again is not found, like removing a record twice.
    await expect(
      deleteLibraryCopy(database.db, { userId, itemId, copyId }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps a record in the collection with no copies after its last copy is removed, until the user moves it", async () => {
    const { itemId, copyId } = await confirmOwnedRecord();
    await deleteLibraryCopy(database.db, { userId, itemId, copyId });

    // The list is the user's statement; clearing inventory does not change it.
    const emptied = await getLibraryItemForUser(database.db, {
      userId,
      itemId,
    });
    expect(emptied).toMatchObject({ list: "collection", copyCount: 0 });
    expect(emptied.copies).toEqual([]);
    const page = await listLibraryItemsForUser(database.db, {
      userId,
      list: "collection",
      query: emptied.release.artist,
    });
    expect(page.items.map((item) => item.id)).toEqual([itemId]);

    // From here the ADR-0011 move applies with nothing to orphan, and moving
    // back records a first copy again.
    const wished = await updateLibraryItem(database.db, {
      userId,
      itemId,
      update: { list: "wishlist" },
    });
    expect(wished).toMatchObject({ list: "wishlist", copyCount: 0 });
    const owned = await updateLibraryItem(database.db, {
      userId,
      itemId,
      update: { list: "collection" },
    });
    expect(owned).toMatchObject({ list: "collection", copyCount: 1 });
    expect(owned.copies[0]!.id).not.toBe(copyId);
  });

  it("records another copy once per idempotency key", async () => {
    const { itemId } = await confirmOwnedRecord();
    const other = await confirmOwnedRecord();
    const before = await getLibraryItemForUser(database.db, {
      userId,
      itemId,
    });
    const key = `copy-${randomUUID()}`;
    const details = {
      ...blankCopy,
      mediaCondition: "near_mint" as const,
      location: "Shelf C",
    };

    const first = await createLibraryCopy(database.db, {
      userId,
      itemId,
      idempotencyKey: key,
      copy: details,
    });
    expect(first.created).toBe(true);
    expect(first.copy).toMatchObject({
      mediaCondition: "near_mint",
      location: "Shelf C",
    });

    // The same key with the same body returns the copy already recorded.
    const replay = await createLibraryCopy(database.db, {
      userId,
      itemId,
      idempotencyKey: key,
      copy: details,
    });
    expect(replay).toEqual({ copy: first.copy, created: false });

    // The same key with a different body, or for a different record, is a
    // conflict rather than a silent second copy.
    await expect(
      createLibraryCopy(database.db, {
        userId,
        itemId,
        idempotencyKey: key,
        copy: { ...details, location: "Shelf D" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      createLibraryCopy(database.db, {
        userId,
        itemId: other.itemId,
        idempotencyKey: key,
        copy: details,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    // A different key records a genuinely distinct copy, blank or not.
    const second = await createLibraryCopy(database.db, {
      userId,
      itemId,
      idempotencyKey: `copy-${randomUUID()}`,
      copy: blankCopy,
    });
    expect(second.created).toBe(true);
    expect(second.copy.id).not.toBe(first.copy.id);

    const after = await getLibraryItemForUser(database.db, { userId, itemId });
    expect(after.copyCount).toBe(3);
    expect(after.copies.map((copy) => copy.id)).toEqual([
      before.copies[0]!.id,
      first.copy.id,
      second.copy.id,
    ]);
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThan(
      new Date(before.updatedAt).getTime(),
    );
    expect(
      (
        await getLibraryItemForUser(database.db, {
          userId,
          itemId: other.itemId,
        })
      ).copyCount,
    ).toBe(1);
  });

  it("rejects a copy on a wishlist record and past the per-record cap", async () => {
    const { itemId, copyId } = await confirmOwnedRecord();
    await deleteLibraryCopy(database.db, { userId, itemId, copyId });
    await updateLibraryItem(database.db, {
      userId,
      itemId,
      update: { list: "wishlist" },
    });
    await expect(
      createLibraryCopy(database.db, {
        userId,
        itemId,
        idempotencyKey: `copy-${randomUUID()}`,
        copy: blankCopy,
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });

    const owned = await updateLibraryItem(database.db, {
      userId,
      itemId,
      update: { list: "collection" },
    });
    await database.db.insert(libraryCopies).values(
      Array.from({ length: MAX_LIBRARY_COPIES_PER_ITEM - 1 }, () => ({
        userId,
        libraryItemId: itemId,
        releaseId: owned.release.id,
      })),
    );
    await expect(
      createLibraryCopy(database.db, {
        userId,
        itemId,
        idempotencyKey: `copy-${randomUUID()}`,
        copy: blankCopy,
      }),
    ).rejects.toMatchObject({ code: "library_copy_limit" });
    const full = await getLibraryItemForUser(database.db, { userId, itemId });
    expect(full.copyCount).toBe(MAX_LIBRARY_COPIES_PER_ITEM);
    expect(full.copies).toHaveLength(MAX_LIBRARY_COPIES_PER_ITEM);
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

  it("dispatches a non-analysis topic without a scan foreign key, a mandatory attempt number, or the cancellation skip (P4.2 Task 2)", async () => {
    // A canceled scan proves the cancellation skip is scoped to
    // scan.analyze.v1: a different topic naming this same canceled scan as
    // its aggregate must still be delivered normally.
    const canceledScan = await createOrGetScan(database.db, {
      userId,
      source: "single_upload",
      idempotencyKey: `generalized-outbox-scan-${randomUUID()}`,
    });
    await cancelScan(database.db, { userId, scanId: canceledScan.record.id });

    const genericTopic = "core.library_export.v1";
    const scanAggregateKey = `generalized-outbox-scan-aggregate-${randomUUID()}`;
    const orphanAggregateId = randomUUID();
    const orphanAggregateKey = `generalized-outbox-orphan-aggregate-${randomUUID()}`;

    // No FK on aggregate_id: this second row's aggregate_id matches no row
    // in any table at all, which the old scans(id) foreign key would have
    // rejected outright.
    await database.db.insert(outboxMessages).values([
      {
        topic: genericTopic,
        aggregateType: "library_export",
        aggregateId: canceledScan.record.id,
        idempotencyKey: scanAggregateKey,
        payload: { message: "canceled scan is not this topic's concern" },
      },
      {
        topic: genericTopic,
        aggregateType: "library_export",
        aggregateId: orphanAggregateId,
        idempotencyKey: orphanAggregateKey,
        payload: { message: "no owning row of any kind" },
      },
    ]);
    // Neither row was given an attempt_number, proving it is now optional.
    const stored = await database.db
      .select({ attemptNumber: outboxMessages.attemptNumber })
      .from(outboxMessages)
      .where(eq(outboxMessages.idempotencyKey, scanAggregateKey));
    expect(stored[0]?.attemptNumber).toBeNull();

    const publishedPayloads: Record<string, unknown> = {};
    async function drainUntilBothDispatched() {
      for (let attempts = 0; attempts < 50; attempts += 1) {
        if (
          scanAggregateKey in publishedPayloads &&
          orphanAggregateKey in publishedPayloads
        ) {
          return;
        }
        const result = await dispatchNextOutboxMessage(
          database.db,
          {
            // Drains any other test's unrelated, still-pending scan.analyze.v1
            // rows (schema.integration.ts's shared-table convention), same as
            // dispatchUntil above.
            [ANALYZE_SCAN_JOB]: async () => {},
            [genericTopic]: async (payload, idempotencyKey) => {
              publishedPayloads[idempotencyKey] = payload;
            },
          },
          new Date(Date.now() + 1_000),
        );
        if (result.status === "idle") {
          throw new Error("Both generalized-outbox rows were never reached.");
        }
      }
      throw new Error("Both generalized-outbox rows were not reached in time.");
    }
    await drainUntilBothDispatched();

    expect(publishedPayloads[scanAggregateKey]).toEqual({
      message: "canceled scan is not this topic's concern",
    });
    expect(publishedPayloads[orphanAggregateKey]).toEqual({
      message: "no owning row of any kind",
    });
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

    await confirmScanAndComplete({
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

describe("favorites and playlists", () => {
  async function saveRecord(
    list: "collection" | "wishlist",
    ownerId: string = userId,
    title = `Saved Music ${randomUUID()}`,
  ) {
    const { record } = await placeLibraryRelease(database.db, {
      userId: ownerId,
      placement: {
        artist: "Saved Music Test",
        title,
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
        list,
        notes: null,
        copy: null,
      },
    });
    return record.libraryItem.id;
  }

  it("favorites a saved record idempotently and lists favorites across both lists", async () => {
    const owned = await saveRecord("collection");
    const wanted = await saveRecord("wishlist");

    const first = await updateLibraryItem(database.db, {
      userId,
      itemId: owned,
      update: { favorite: true },
    });
    expect(first.favoritedAt).not.toBeNull();
    const repeated = await updateLibraryItem(database.db, {
      userId,
      itemId: owned,
      update: { favorite: true },
    });
    // A repeated favorite keeps the original moment rather than resetting it.
    expect(repeated.favoritedAt).toBe(first.favoritedAt);

    await updateLibraryItem(database.db, {
      userId,
      itemId: wanted,
      update: { favorite: true },
    });

    const favorites = await listFavoriteLibraryItemsForUser(database.db, {
      userId,
    });
    const favoriteIds = favorites.items.map((item) => item.id);
    expect(favoriteIds).toContain(owned);
    expect(favoriteIds).toContain(wanted);
    // Most recently favorited first, whichever list the record is in.
    expect(favoriteIds.indexOf(wanted)).toBeLessThan(
      favoriteIds.indexOf(owned),
    );
    expect(favorites.items.map((item) => item.list).sort()).toEqual(
      expect.arrayContaining(["collection", "wishlist"]),
    );

    const cleared = await updateLibraryItem(database.db, {
      userId,
      itemId: owned,
      update: { favorite: false },
    });
    expect(cleared.favoritedAt).toBeNull();
    const clearedAgain = await updateLibraryItem(database.db, {
      userId,
      itemId: owned,
      update: { favorite: false },
    });
    expect(clearedAgain.favoritedAt).toBeNull();
    expect(
      (
        await listFavoriteLibraryItemsForUser(database.db, { userId })
      ).items.map((item) => item.id),
    ).not.toContain(owned);
  });

  it("creates a playlist once per normalized name and rejects renaming onto another", async () => {
    const suffix = randomUUID();
    const created = await createPlaylist(database.db, {
      userId,
      name: `Road Trip ${suffix}`,
    });
    expect(created.created).toBe(true);
    expect(created.playlist.entries).toEqual([]);

    const replayed = await createPlaylist(database.db, {
      userId,
      name: `  road   trip ${suffix} `,
    });
    expect(replayed.created).toBe(false);
    expect(replayed.playlist.id).toBe(created.playlist.id);
    // The display name is the one first given, not the replay's spelling.
    expect(replayed.playlist.name).toBe(`Road Trip ${suffix}`);

    const other = await createPlaylist(database.db, {
      userId,
      name: `Sunday ${suffix}`,
    });
    await expect(
      updatePlaylist(database.db, {
        userId,
        playlistId: other.playlist.id,
        update: { name: `ROAD TRIP ${suffix}` },
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const renamed = await updatePlaylist(database.db, {
      userId,
      playlistId: other.playlist.id,
      update: { name: `Sunday morning ${suffix}` },
    });
    expect(renamed.name).toBe(`Sunday morning ${suffix}`);
    // Renaming to its own current name is a harmless replay.
    await expect(
      updatePlaylist(database.db, {
        userId,
        playlistId: other.playlist.id,
        update: { name: `Sunday morning ${suffix}` },
      }),
    ).resolves.toMatchObject({ name: `Sunday morning ${suffix}` });

    const listed = await listPlaylistsForUser(database.db, { userId });
    expect(listed.playlists.map((playlist) => playlist.id)).toEqual(
      expect.arrayContaining([created.playlist.id, other.playlist.id]),
    );
  });

  it("adds each saved record once, in append order, and never someone else's", async () => {
    const { playlist } = await createPlaylist(database.db, {
      userId,
      name: `Append ${randomUUID()}`,
    });
    const first = await saveRecord("collection");
    const second = await saveRecord("wishlist");

    const added = await addPlaylistEntry(database.db, {
      userId,
      playlistId: playlist.id,
      libraryItemId: first,
    });
    expect(added.created).toBe(true);
    expect(added.playlist.entries).toHaveLength(1);
    expect(added.playlist.entries[0]).toMatchObject({
      position: 1,
      item: { id: first, list: "collection" },
    });

    const replayed = await addPlaylistEntry(database.db, {
      userId,
      playlistId: playlist.id,
      libraryItemId: first,
    });
    expect(replayed.created).toBe(false);
    expect(replayed.playlist.entries).toHaveLength(1);

    const appended = await addPlaylistEntry(database.db, {
      userId,
      playlistId: playlist.id,
      libraryItemId: second,
    });
    expect(appended.playlist.entries.map((entry) => entry.item.id)).toEqual([
      first,
      second,
    ]);
    expect(appended.playlist.entries[1]).toMatchObject({ position: 2 });

    // Ownership: another user's saved record cannot be referenced, and
    // another user's playlist cannot be read or changed — both read as absent.
    const [stranger] = await database.db.insert(users).values({}).returning();
    const strangerItem = await saveRecord("collection", stranger!.id);
    await expect(
      addPlaylistEntry(database.db, {
        userId,
        playlistId: playlist.id,
        libraryItemId: strangerItem,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      getPlaylistForUser(database.db, {
        userId: stranger!.id,
        playlistId: playlist.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      addPlaylistEntry(database.db, {
        userId: stranger!.id,
        playlistId: playlist.id,
        libraryItemId: strangerItem,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      updatePlaylist(database.db, {
        userId: stranger!.id,
        playlistId: playlist.id,
        update: { name: "Hijacked" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      deletePlaylist(database.db, {
        userId: stranger!.id,
        playlistId: playlist.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      (await listPlaylistsForUser(database.db, { userId: stranger!.id }))
        .playlists,
    ).toEqual([]);
    await database.db.delete(users).where(eq(users.id, stranger!.id));
  });

  it("reorders with a complete permutation and rejects a stale or partial order", async () => {
    const { playlist } = await createPlaylist(database.db, {
      userId,
      name: `Reorder ${randomUUID()}`,
    });
    const items = [
      await saveRecord("collection"),
      await saveRecord("collection"),
      await saveRecord("wishlist"),
    ];
    for (const libraryItemId of items) {
      await addPlaylistEntry(database.db, {
        userId,
        playlistId: playlist.id,
        libraryItemId,
      });
    }
    const before = await getPlaylistForUser(database.db, {
      userId,
      playlistId: playlist.id,
    });
    const [a, b, c] = before.entries.map((entry) => entry.id) as [
      string,
      string,
      string,
    ];

    const reordered = await updatePlaylist(database.db, {
      userId,
      playlistId: playlist.id,
      update: { entryIds: [c, a, b] },
    });
    expect(reordered.entries.map((entry) => entry.id)).toEqual([c, a, b]);
    expect(reordered.entries.map((entry) => entry.position)).toEqual([1, 2, 3]);

    // Replaying the same order converges.
    await expect(
      updatePlaylist(database.db, {
        userId,
        playlistId: playlist.id,
        update: { entryIds: [c, a, b] },
      }),
    ).resolves.toMatchObject({ entries: [{ id: c }, { id: a }, { id: b }] });

    // A partial order (an entry left out) and an unknown entry are both
    // stale views and are refused rather than partially applied.
    await expect(
      updatePlaylist(database.db, {
        userId,
        playlistId: playlist.id,
        update: { entryIds: [c, a] },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      updatePlaylist(database.db, {
        userId,
        playlistId: playlist.id,
        update: { entryIds: [c, a, b, randomUUID()] },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const unchanged = await getPlaylistForUser(database.db, {
      userId,
      playlistId: playlist.id,
    });
    expect(unchanged.entries.map((entry) => entry.id)).toEqual([c, a, b]);
  });

  it("removes an entry without renumbering and drops entries when the saved record is removed", async () => {
    const { playlist } = await createPlaylist(database.db, {
      userId,
      name: `Remove ${randomUUID()}`,
    });
    const first = await saveRecord("collection");
    const second = await saveRecord("wishlist");
    const third = await saveRecord("wishlist");
    for (const libraryItemId of [first, second, third]) {
      await addPlaylistEntry(database.db, {
        userId,
        playlistId: playlist.id,
        libraryItemId,
      });
    }
    const detail = await getPlaylistForUser(database.db, {
      userId,
      playlistId: playlist.id,
    });
    const secondEntry = detail.entries[1]!;

    const removed = await removePlaylistEntry(database.db, {
      userId,
      playlistId: playlist.id,
      entryId: secondEntry.id,
    });
    expect(removed.id).toBe(secondEntry.id);
    await expect(
      removePlaylistEntry(database.db, {
        userId,
        playlistId: playlist.id,
        entryId: secondEntry.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    const afterRemove = await getPlaylistForUser(database.db, {
      userId,
      playlistId: playlist.id,
    });
    // The gap is kept and the next append goes after the old maximum.
    expect(afterRemove.entries.map((entry) => entry.position)).toEqual([1, 3]);
    const appended = await addPlaylistEntry(database.db, {
      userId,
      playlistId: playlist.id,
      libraryItemId: second,
    });
    expect(appended.playlist.entries.map((entry) => entry.position)).toEqual([
      1, 3, 4,
    ]);

    // Removing the saved record removes it from the playlist by cascade.
    await deleteLibraryItem(database.db, { userId, itemId: third });
    const afterItemDelete = await getPlaylistForUser(database.db, {
      userId,
      playlistId: playlist.id,
    });
    expect(afterItemDelete.entries.map((entry) => entry.item.id)).toEqual([
      first,
      second,
    ]);

    // Deleting the playlist removes its entries but never the saved records.
    await deletePlaylist(database.db, { userId, playlistId: playlist.id });
    await expect(
      getPlaylistForUser(database.db, { userId, playlistId: playlist.id }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await database.db
        .select()
        .from(playlistEntries)
        .where(eq(playlistEntries.playlistId, playlist.id)),
    ).toHaveLength(0);
    await expect(
      getLibraryItemForUser(database.db, { userId, itemId: first }),
    ).resolves.toMatchObject({ id: first });
  });

  it("enforces the per-user playlist and per-playlist entry limits", async () => {
    const [account] = await database.db.insert(users).values({}).returning();
    const ownerId = account!.id;

    await database.db.insert(playlists).values(
      Array.from({ length: MAX_PLAYLISTS_PER_USER }, (_, index) => ({
        userId: ownerId,
        name: `Filler ${index}`,
        normalizedName: `filler ${index}`,
      })),
    );
    await expect(
      createPlaylist(database.db, { userId: ownerId, name: "One too many" }),
    ).rejects.toMatchObject({ code: "playlist_limit" });
    // Converging on an existing name is still allowed at the limit.
    await expect(
      createPlaylist(database.db, { userId: ownerId, name: "filler 0" }),
    ).resolves.toMatchObject({ created: false });

    const [playlist] = await database.db
      .select()
      .from(playlists)
      .where(
        and(
          eq(playlists.userId, ownerId),
          eq(playlists.normalizedName, "filler 0"),
        ),
      );
    // Bulk-seed distinct saved records so the entry limit can be reached
    // without hundreds of round trips.
    const [album] = await database.db
      .insert(albums)
      .values({
        artist: "Limit Test",
        title: `Limit ${ownerId}`,
        normalizedArtist: "limit test",
        normalizedTitle: `limit ${ownerId}`,
      })
      .returning();
    const seededReleases = await database.db
      .insert(releases)
      .values(
        Array.from({ length: MAX_PLAYLIST_ENTRIES }, () => ({
          albumId: album!.id,
          identityKey: randomUUID().replaceAll("-", "").padEnd(64, "0"),
        })),
      )
      .returning({ id: releases.id });
    const seededItems = await database.db
      .insert(libraryItems)
      .values(
        seededReleases.map((release) => ({
          userId: ownerId,
          releaseId: release.id,
          list: "wishlist" as const,
        })),
      )
      .returning({ id: libraryItems.id });
    await database.db.insert(playlistEntries).values(
      seededItems.slice(0, MAX_PLAYLIST_ENTRIES - 1).map((item, index) => ({
        playlistId: playlist!.id,
        userId: ownerId,
        libraryItemId: item.id,
        position: index + 1,
      })),
    );

    const last = seededItems[MAX_PLAYLIST_ENTRIES - 1]!.id;
    const full = await addPlaylistEntry(database.db, {
      userId: ownerId,
      playlistId: playlist!.id,
      libraryItemId: last,
    });
    expect(full.created).toBe(true);
    expect(full.playlist.entries).toHaveLength(MAX_PLAYLIST_ENTRIES);

    const extra = await saveRecord("wishlist", ownerId);
    await expect(
      addPlaylistEntry(database.db, {
        userId: ownerId,
        playlistId: playlist!.id,
        libraryItemId: extra,
      }),
    ).rejects.toMatchObject({ code: "playlist_entry_limit" });
    // Re-adding a record already present converges even when full.
    await expect(
      addPlaylistEntry(database.db, {
        userId: ownerId,
        playlistId: playlist!.id,
        libraryItemId: last,
      }),
    ).resolves.toMatchObject({ created: false });

    await database.db.delete(users).where(eq(users.id, ownerId));
    await database.db.delete(albums).where(eq(albums.id, album!.id));
  });
});

describe("full-library search and keyset pagination", () => {
  // A dedicated account, so the counts below are exact whatever the other
  // blocks in this file have saved for the shared user.
  let ownerId: string;
  const artists = ["Alice Coltrane", "Bill Evans", "Charles Mingus"] as const;
  const seeded: { id: string; artist: string; title: string }[] = [];
  const SEED_COUNT = 120;

  async function place(input: {
    artist: string;
    title: string;
    list?: "collection" | "wishlist";
    ownerId?: string;
  }) {
    const { record } = await placeLibraryRelease(database.db, {
      userId: input.ownerId ?? ownerId,
      placement: {
        artist: input.artist,
        title: input.title,
        releaseYear: null,
        label: null,
        catalogNumber: null,
        barcode: null,
        releaseDate: null,
        country: null,
        format: null,
        packaging: null,
        releaseStatus: null,
        catalogReference: null,
        list: input.list ?? "wishlist",
        notes: null,
        copy: null,
      },
    });
    return record.libraryItem.id;
  }

  /** Walks every page under one sort and returns the ids in page order. */
  async function walk(input: {
    list?: "collection" | "wishlist";
    query?: string;
    sort?: "recent" | "artist" | "title";
    limit: number;
    favorites?: boolean;
  }) {
    const ids: string[] = [];
    const pages: number[] = [];
    const items: LibraryItemResult[] = [];
    let cursor: string | undefined;
    do {
      const page = input.favorites
        ? await listFavoriteLibraryItemsForUser(database.db, {
            userId: ownerId,
            query: input.query,
            sort: input.sort,
            cursor,
            limit: input.limit,
          })
        : await listLibraryItemsForUser(database.db, {
            userId: ownerId,
            list: input.list ?? "wishlist",
            query: input.query,
            sort: input.sort,
            cursor,
            limit: input.limit,
          });
      expect(page.items.length).toBeLessThanOrEqual(input.limit);
      pages.push(page.items.length);
      ids.push(...page.items.map((item) => item.id));
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
      // A continuation is only ever handed out for a full page.
      if (cursor) expect(page.items.length).toBe(input.limit);
    } while (cursor);
    return { ids, pages, items };
  }

  beforeAll(async () => {
    const [account] = await database.db.insert(users).values({}).returning();
    ownerId = account!.id;
    // Titles are zero-padded so their alphabetical order is the seed order
    // and the 110th record is provably past the old 100-row fetch.
    for (let index = 0; index < SEED_COUNT; index += 1) {
      const artist = artists[index % artists.length]!;
      const title = `Pagination Record ${String(index).padStart(3, "0")}`;
      seeded.push({ id: await place({ artist, title }), artist, title });
    }
  }, 60_000);

  it("finds a record past the first hundred rows and reports no false matches", async () => {
    const target = seeded[110]!;
    const found = await listLibraryItemsForUser(database.db, {
      userId: ownerId,
      list: "wishlist",
      query: "pagination RECORD 110",
    });
    expect(found.items.map((item) => item.id)).toEqual([target.id]);
    expect(found.nextCursor).toBeNull();

    // LIKE wildcards in the query are literal characters, not patterns.
    const wildcard = await listLibraryItemsForUser(database.db, {
      userId: ownerId,
      list: "wishlist",
      query: "Pagination Record 1__",
    });
    expect(wildcard.items).toEqual([]);
    const percent = await listLibraryItemsForUser(database.db, {
      userId: ownerId,
      list: "wishlist",
      query: "%",
    });
    expect(percent.items).toEqual([]);
  });

  it("matches and orders by the confirmed artist and title, not the album row", async () => {
    // A scan confirmation carries corrected values that differ from the
    // shared album row the release was resolved to; search and sort must
    // follow what the user confirmed and sees (ADR-0012).
    const [scan] = await database.db
      .insert(scans)
      .values({
        userId: ownerId,
        source: "single_upload",
        status: "identified",
        idempotencyKey: `pagination-confirm-scan-${randomUUID()}`,
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
    const confirmed = await confirmScanAndComplete({
      userId: ownerId,
      scanId: scan!.id,
      idempotencyKey: `pagination-confirm-${randomUUID()}`,
      confirmation: {
        selectedCandidateId: null,
        artist: "Aardvark Corrected Artist",
        title: "Zz Corrected Title",
        releaseYear: null,
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
    const itemId = confirmed.record.libraryItem!.id;
    // Change the album row underneath so it no longer matches what was
    // confirmed — the equivalent of another user's copy sharing the row.
    const [release] = await database.db
      .select({ albumId: releases.albumId })
      .from(releases)
      .where(eq(releases.id, confirmed.record.release!.id));
    await database.db
      .update(albums)
      .set({ artist: "Zzz Album Row Artist", title: "Album Row Title" })
      .where(eq(albums.id, release!.albumId));

    const byConfirmed = await listLibraryItemsForUser(database.db, {
      userId: ownerId,
      list: "wishlist",
      query: "aardvark corrected",
    });
    expect(byConfirmed.items.map((item) => item.id)).toEqual([itemId]);
    expect(byConfirmed.items[0]!.release.artist).toBe(
      "Aardvark Corrected Artist",
    );
    const byAlbumRow = await listLibraryItemsForUser(database.db, {
      userId: ownerId,
      list: "wishlist",
      query: "album row",
    });
    expect(byAlbumRow.items).toEqual([]);

    // Sorted by artist the corrected name comes first of everything; sorted
    // by title it comes last — the album row's values place it nowhere near.
    const byArtist = await walk({ sort: "artist", limit: 100 });
    expect(byArtist.ids[0]).toBe(itemId);
    const byTitle = await walk({ sort: "title", limit: 100 });
    expect(byTitle.ids[byTitle.ids.length - 1]).toBe(itemId);

    await deleteLibraryItem(database.db, { userId: ownerId, itemId });
  });

  it("pages every sort without duplicates or gaps, in a total order", async () => {
    const expectedIds = new Set(seeded.map((record) => record.id));
    for (const sort of ["recent", "artist", "title"] as const) {
      const { ids, pages } = await walk({ sort, limit: 7 });
      expect(ids, sort).toHaveLength(SEED_COUNT);
      expect(new Set(ids).size, sort).toBe(SEED_COUNT);
      expect(new Set(ids), sort).toEqual(expectedIds);
      expect(pages, sort).toEqual([
        ...Array<number>(Math.floor(SEED_COUNT / 7)).fill(7),
        SEED_COUNT % 7,
      ]);
    }

    // The name sorts order by lower-cased artist then title then id, and
    // the page walk reproduces exactly that sequence.
    const byArtist = await walk({ sort: "artist", limit: 7 });
    const expectedByArtist = [...seeded].sort(
      (a, b) =>
        compare(a.artist, b.artist) ||
        compare(a.title, b.title) ||
        compare(a.id, b.id),
    );
    expect(byArtist.ids).toEqual(expectedByArtist.map((record) => record.id));

    const byTitle = await walk({ sort: "title", limit: 7 });
    const expectedByTitle = [...seeded].sort(
      (a, b) =>
        compare(a.title, b.title) ||
        compare(a.artist, b.artist) ||
        compare(a.id, b.id),
    );
    expect(byTitle.ids).toEqual(expectedByTitle.map((record) => record.id));

    // A search walks the same way over only the matching rows.
    const searched = await walk({
      sort: "title",
      limit: 7,
      query: "bill evans",
    });
    expect(searched.ids).toEqual(
      expectedByTitle
        .filter((record) => record.artist === "Bill Evans")
        .map((record) => record.id),
    );
  });

  it("keeps a page sequence stable while records are added and edited between pages", async () => {
    const firstPage = await listLibraryItemsForUser(database.db, {
      userId: ownerId,
      list: "wishlist",
      sort: "recent",
      limit: 10,
    });
    expect(firstPage.nextCursor).not.toBeNull();
    const seen = new Set(firstPage.items.map((item) => item.id));

    // A new record and an edit both move to the top of `recent`, which is
    // before the cursor, so neither reappears on the pages still to come
    // and nothing already there is skipped — unlike an offset.
    const added = await place({
      artist: "Late Addition",
      title: "Arrived Between Pages",
    });
    const edited = firstPage.items[3]!.id;
    await updateLibraryItem(database.db, {
      userId: ownerId,
      itemId: edited,
      update: { notes: "edited mid-walk" },
    });

    const rest: string[] = [];
    let cursor = firstPage.nextCursor ?? undefined;
    while (cursor) {
      const page = await listLibraryItemsForUser(database.db, {
        userId: ownerId,
        list: "wishlist",
        sort: "recent",
        cursor,
        limit: 10,
      });
      rest.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    }
    expect(rest).not.toContain(added);
    expect(rest).not.toContain(edited);
    for (const id of rest) expect(seen.has(id), id).toBe(false);
    expect(seen.size + rest.length).toBe(SEED_COUNT);

    await deleteLibraryItem(database.db, { userId: ownerId, itemId: added });
  });

  it("orders ties on the same millisecond deterministically", async () => {
    // Every seeded row was inserted in one tight loop, so many share a
    // millisecond and some may share a microsecond; the id tiebreak makes
    // the recent walk identical whatever the page size.
    const bySeven = await walk({ sort: "recent", limit: 7 });
    const byThirteen = await walk({ sort: "recent", limit: 13 });
    const byHundred = await walk({ sort: "recent", limit: 100 });
    expect(byThirteen.ids).toEqual(bySeven.ids);
    expect(byHundred.ids).toEqual(bySeven.ids);
  });

  it("pages favorites by when they were starred", async () => {
    const starred = seeded.slice(20, 35);
    for (const record of starred) {
      await updateLibraryItem(database.db, {
        userId: ownerId,
        itemId: record.id,
        update: { favorite: true },
      });
    }
    const { ids, pages, items } = await walk({ favorites: true, limit: 4 });
    expect(pages).toEqual([4, 4, 4, 3]);
    expect(new Set(ids)).toEqual(new Set(starred.map((record) => record.id)));
    // Most recently starred first, across page boundaries.
    for (let index = 1; index < items.length; index += 1) {
      expect(
        items[index - 1]!.favoritedAt! >= items[index]!.favoritedAt!,
        `${ids[index - 1]} before ${ids[index]}`,
      ).toBe(true);
    }

    const searched = await walk({
      favorites: true,
      limit: 4,
      query: "record 02",
    });
    expect(new Set(searched.ids)).toEqual(
      new Set(
        starred
          .filter((record) => record.title.includes("Record 02"))
          .map((record) => record.id),
      ),
    );
  });

  it("iterates every matching record for an export across page boundaries", async () => {
    const pages: number[] = [];
    const ids: string[] = [];
    for await (const page of iterateLibraryItemsForUser(database.db, {
      userId: ownerId,
      list: "wishlist",
      sort: "artist",
      pageSize: 100,
    })) {
      pages.push(page.length);
      ids.push(...page.map((item) => item.id));
    }
    expect(pages).toEqual([100, SEED_COUNT - 100]);
    expect(new Set(ids).size).toBe(SEED_COUNT);

    const none: unknown[] = [];
    for await (const page of iterateLibraryItemsForUser(database.db, {
      userId: ownerId,
      list: "collection",
    })) {
      none.push(page);
    }
    expect(none).toEqual([]);
  });

  it("rejects a cursor it cannot read or that belongs to another sort", async () => {
    const page = await listLibraryItemsForUser(database.db, {
      userId: ownerId,
      list: "wishlist",
      sort: "artist",
      limit: 5,
    });
    await expect(
      listLibraryItemsForUser(database.db, {
        userId: ownerId,
        list: "wishlist",
        sort: "title",
        cursor: page.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(
      listLibraryItemsForUser(database.db, {
        userId: ownerId,
        list: "wishlist",
        cursor: "not-a-cursor",
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it("never pages into another user's records", async () => {
    const other = await place({
      artist: "Alice Coltrane",
      title: "Pagination Record 000",
      ownerId: userId,
    });
    const { ids } = await walk({ sort: "artist", limit: 50 });
    expect(ids).not.toContain(other);
    expect(ids).toHaveLength(SEED_COUNT);
    await deleteLibraryItem(database.db, { userId, itemId: other });
  });

  function compare(a: string, b: string) {
    const left = a.toLowerCase();
    const right = b.toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  }
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
    const confirmation = await confirmScanAndComplete({
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

    // Saved-music data (roadmap P3.3 Task 2) must travel with the account.
    await updateLibraryItem(database.db, {
      userId: accountId,
      itemId: confirmation.record.libraryItem!.id,
      update: { favorite: true },
    });
    const { playlist } = await createPlaylist(database.db, {
      userId: accountId,
      name: "Export me",
    });
    await addPlaylistEntry(database.db, {
      userId: accountId,
      playlistId: playlist.id,
      libraryItemId: confirmation.record.libraryItem!.id,
    });

    return {
      accountId,
      scanId: scan!.id,
      confirmation,
      playlistId: playlist.id,
    };
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
      libraryItemId: confirmation.record.libraryItem!.id,
    });
    expect(exported.libraryItems).toHaveLength(1);
    expect(exported.libraryItems[0]!.favoritedAt).not.toBeNull();
    expect(exported.libraryCopies).toHaveLength(1);
    expect(exported.playlists).toEqual([
      expect.objectContaining({ name: "Export me" }),
    ]);
    expect(exported.playlistEntries).toEqual([
      expect.objectContaining({
        libraryItemId: confirmation.record.libraryItem!.id,
        position: 1,
      }),
    ]);

    await deleteAccount(database.db, { userId: accountId });
  });

  it("rejects exporting an account that does not exist", async () => {
    await expect(
      getAccountExportForUser(database.db, { userId: randomUUID() }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("deletes an account with confirmation history despite the restrict FKs, without touching shared catalog rows", async () => {
    const { accountId, scanId, playlistId } = await createAccountWithData();
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
    expect(
      await database.db
        .select()
        .from(playlists)
        .where(eq(playlists.id, playlistId)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(playlistEntries)
        .where(eq(playlistEntries.playlistId, playlistId)),
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

describe("P4.2 Task 3: async scan-confirmation pipeline (ADR-0028)", () => {
  async function insertReviewableScan() {
    const [scan] = await database.db
      .insert(scans)
      .values({
        userId,
        source: "single_upload",
        status: "identified",
        idempotencyKey: `pipeline-scan-${randomUUID()}`,
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
    return scan!.id;
  }

  function collectionConfirmationInput(scanId: string) {
    return {
      userId,
      scanId,
      idempotencyKey: `pipeline-confirm-${randomUUID()}`,
      confirmation: {
        selectedCandidateId: null,
        artist: `Pipeline Test Artist ${randomUUID()}`,
        title: "Pipeline Test Title",
        releaseYear: 1985,
        label: null,
        catalogNumber: null,
        barcode: null,
        releaseDate: null,
        country: null,
        format: null,
        packaging: null,
        releaseStatus: null,
        catalogReference: null,
        list: "collection" as const,
        notes: null,
        copy: {
          mediaCondition: "very_good_plus" as const,
          sleeveCondition: null,
          location: null,
          notes: null,
          acquiredAt: null,
        },
      },
    };
  }

  async function readOutboxEvent(scanId: string, idempotencyKey: string) {
    const eventKey = confirmationEventId(scanId, idempotencyKey);
    const [row] = await database.db
      .select()
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.topic, SCAN_CONFIRMED_EVENT),
          eq(outboxMessages.idempotencyKey, eventKey),
        ),
      )
      .limit(1);
    if (!row) {
      throw new Error(`No scan.confirmed.v1 outbox row for scan ${scanId}.`);
    }
    return {
      row,
      eventKey,
      event: SCAN_CONFIRMED_EVENT_CONTRACT.consumerSchema.parse(row.payload),
    };
  }

  /**
   * `confirmation_receipts` is shared across every test in this file, the
   * same way `outbox_messages` is (see `dispatchUntil` above) -- an earlier
   * test's confirmed-but-never-dispatched receipt can still be sitting in
   * the table. Dispatch repeatedly, draining unrelated rows with a no-op
   * publish, until the target receipt is reached.
   */
  async function dispatchConfirmationReceiptUntil(
    targetKey: string,
    publish: (payload: unknown) => Promise<void>,
    now = new Date(Date.now() + 1_000),
  ) {
    for (let attempts = 0; attempts < 50; attempts += 1) {
      const result = await dispatchNextConfirmationReceipt(
        database.db,
        async (payload, idempotencyKey) => {
          if (idempotencyKey === targetKey) {
            await publish(payload);
          }
        },
        now,
      );
      if (result.status === "idle") {
        throw new Error(`Target receipt ${targetKey} was never dispatched.`);
      }
      if (result.idempotencyKey === targetKey) {
        return result;
      }
    }
    throw new Error(`Target receipt ${targetKey} was not reached in time.`);
  }

  it("records a pending confirmation and its event, writing no library rows", async () => {
    const scanId = await insertReviewableScan();
    const input = collectionConfirmationInput(scanId);

    const result = await confirmScan(database.db, input);

    expect(result.created).toBe(true);
    expect(result.record).toMatchObject({
      scanId,
      status: "pending",
      release: null,
      libraryItem: null,
      completedAt: null,
    });

    const { row, event } = await readOutboxEvent(scanId, input.idempotencyKey);
    expect(row).toMatchObject({
      aggregateType: "scan_confirmation",
      publishedAt: null,
    });
    expect(event).toMatchObject({
      scanId,
      userId,
      idempotencyKey: input.idempotencyKey,
      list: "collection",
    });

    const [storedConfirmation] = await database.db
      .select()
      .from(scanConfirmations)
      .where(eq(scanConfirmations.scanId, scanId));
    expect(storedConfirmation).toMatchObject({
      status: "pending",
      releaseId: null,
      libraryItemId: null,
      copyId: null,
    });
    expect(
      await database.db
        .select()
        .from(libraryItems)
        .where(eq(libraryItems.confirmedFromScanId, scanId)),
    ).toHaveLength(0);
  });

  it("replays a pending confirmation idempotently and still conflicts on a different payload, never treating it as removed", async () => {
    const scanId = await insertReviewableScan();
    const input = collectionConfirmationInput(scanId);

    const first = await confirmScan(database.db, input);
    const replay = await confirmScan(database.db, input);

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.record).toEqual(first.record);

    await expect(
      confirmScan(database.db, {
        ...input,
        confirmation: { ...input.confirmation, title: "A different title" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    // A conflict must not have deleted-and-reset the pending row (the
    // ADR-0018 "removed" branch, which a pending confirmation's null
    // libraryItemId could otherwise be mistaken for).
    const [stillPending] = await database.db
      .select()
      .from(scanConfirmations)
      .where(eq(scanConfirmations.scanId, scanId));
    expect(stillPending).toMatchObject({ status: "pending" });
  });

  it("processScanConfirmation resolves the release and writes the library row exactly once, even if the event is delivered twice", async () => {
    const scanId = await insertReviewableScan();
    const input = collectionConfirmationInput(scanId);
    await confirmScan(database.db, input);
    const { event, eventKey } = await readOutboxEvent(
      scanId,
      input.idempotencyKey,
    );

    await processScanConfirmation(database.db, event);
    await processScanConfirmation(database.db, event);

    const receipts = await database.db
      .select()
      .from(confirmationReceipts)
      .where(eq(confirmationReceipts.idempotencyKey, eventKey));
    expect(receipts).toHaveLength(1);

    const libraryRows = await database.db
      .select()
      .from(libraryItems)
      .where(eq(libraryItems.confirmedFromScanId, scanId));
    expect(libraryRows).toHaveLength(1);
    const copyRows = await database.db
      .select()
      .from(libraryCopies)
      .where(eq(libraryCopies.confirmedFromScanId, scanId));
    expect(copyRows).toHaveLength(1);
  });

  it("applyConfirmationCompletion projects the completion and is idempotent against redelivery or a missing row", async () => {
    const scanId = await insertReviewableScan();
    const input = collectionConfirmationInput(scanId);
    await confirmScan(database.db, input);
    const { event, eventKey } = await readOutboxEvent(
      scanId,
      input.idempotencyKey,
    );
    await processScanConfirmation(database.db, event);
    const [receipt] = await database.db
      .select()
      .from(confirmationReceipts)
      .where(eq(confirmationReceipts.idempotencyKey, eventKey));
    const completion =
      CONFIRMATION_COMPLETED_EVENT_CONTRACT.consumerSchema.parse(
        receipt!.payload,
      );

    await applyConfirmationCompletion(database.db, completion);
    const [afterFirst] = await database.db
      .select()
      .from(scanConfirmations)
      .where(eq(scanConfirmations.scanId, scanId));
    expect(afterFirst).toMatchObject({
      status: "completed",
      releaseId: completion.releaseId,
      libraryItemId: completion.libraryItemId,
      copyId: completion.copyId,
    });

    // Redelivery after completion is a silent no-op, not a re-application.
    await applyConfirmationCompletion(database.db, completion);
    const [afterRedelivery] = await database.db
      .select()
      .from(scanConfirmations)
      .where(eq(scanConfirmations.scanId, scanId));
    expect(afterRedelivery).toEqual(afterFirst);

    // A completion event naming a scan/idempotencyKey with no matching row
    // is a defensive no-op, not a throw -- this handler runs from a queue
    // consumer with no request to fail back to.
    await expect(
      applyConfirmationCompletion(database.db, {
        ...completion,
        scanId: randomUUID(),
        idempotencyKey: `orphan-${randomUUID()}`,
      }),
    ).resolves.toBeUndefined();
  });

  it("dispatchNextConfirmationReceipt claims, backs off on a failed publish, and marks published on success", async () => {
    const scanId = await insertReviewableScan();
    const input = collectionConfirmationInput(scanId);
    await confirmScan(database.db, input);
    const { event, eventKey } = await readOutboxEvent(
      scanId,
      input.idempotencyKey,
    );
    await processScanConfirmation(database.db, event);

    const firstDispatchAt = new Date(Date.now() + 1_000);
    await dispatchConfirmationReceiptUntil(
      eventKey,
      async () => {
        throw new Error("synthetic delivery failure");
      },
      firstDispatchAt,
    );
    const [afterDeferral] = await database.db
      .select()
      .from(confirmationReceipts)
      .where(eq(confirmationReceipts.idempotencyKey, eventKey));
    expect(afterDeferral).toMatchObject({
      publishAttempts: 1,
      publishedAt: null,
      lastError: "Queue publication failed.",
    });
    expect(afterDeferral?.availableAt.getTime()).toBeGreaterThan(
      firstDispatchAt.getTime(),
    );

    const publishedPayloads: unknown[] = [];
    // Past the backoff delay this deferral just set, and far enough ahead
    // that any other test's stale, similarly-backed-off row is also due --
    // this dispatcher has no target-matching of its own, only the
    // draining helper above does.
    const published = await dispatchConfirmationReceiptUntil(
      eventKey,
      async (payload) => {
        publishedPayloads.push(payload);
      },
      new Date(firstDispatchAt.getTime() + 60_000),
    );
    expect(published.status).toBe("published");
    expect(publishedPayloads).toEqual([
      expect.objectContaining({ scanId, idempotencyKey: event.idempotencyKey }),
    ]);

    const [receipt] = await database.db
      .select()
      .from(confirmationReceipts)
      .where(eq(confirmationReceipts.idempotencyKey, eventKey));
    expect(receipt?.publishedAt).toBeInstanceOf(Date);
  });

  it("runs the full pipeline end to end without a queue, from a pending confirmation to a completed projection", async () => {
    const scanId = await insertReviewableScan();
    const input = collectionConfirmationInput(scanId);

    const pending = await confirmScan(database.db, input);
    expect(pending.record.status).toBe("pending");

    const { event, eventKey } = await readOutboxEvent(
      scanId,
      input.idempotencyKey,
    );
    await processScanConfirmation(database.db, event);
    const dispatched = await dispatchConfirmationReceiptUntil(
      eventKey,
      async (payload) => {
        await applyConfirmationCompletion(
          database.db,
          payload as Parameters<typeof applyConfirmationCompletion>[1],
        );
      },
    );
    expect(dispatched.status).toBe("published");

    await expect(
      getScanForUser(database.db, { userId, scanId }),
    ).resolves.toMatchObject({
      confirmation: {
        status: "completed",
        release: { artist: input.confirmation.artist },
        libraryItem: { list: "collection" },
      },
    });
  });

  it("exports a pending confirmation with a null releaseId and pending status", async () => {
    const [account] = await database.db.insert(users).values({}).returning();
    const accountId = account!.id;
    const [scan] = await database.db
      .insert(scans)
      .values({
        userId: accountId,
        source: "single_upload",
        status: "identified",
        idempotencyKey: `pipeline-export-scan-${randomUUID()}`,
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
    await confirmScan(database.db, {
      userId: accountId,
      scanId: scan!.id,
      idempotencyKey: `pipeline-export-confirm-${randomUUID()}`,
      confirmation: {
        selectedCandidateId: null,
        artist: "Pending Export Artist",
        title: "Pending Export Title",
        releaseYear: null,
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

    const exported = await getAccountExportForUser(database.db, {
      userId: accountId,
    });
    expect(exported.confirmations).toEqual([
      expect.objectContaining({
        scanId: scan!.id,
        libraryItemId: null,
        releaseId: null,
        status: "pending",
        list: null,
      }),
    ]);

    await deleteAccount(database.db, { userId: accountId });
  });
});
