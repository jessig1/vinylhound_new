import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";
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

import { createCoreDatabase, createScanDatabase } from "./database.ts";
import {
  deleteAccount,
  finalizeAccountDeletion,
  getAccountExportForUser,
  listAccountsPendingDeletion,
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
  listStalePendingConfirmations,
  reconcileScanConfirmation,
} from "./confirmation-reconciliation-repository.ts";
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
  getScanQuotaHeadroomForUser,
  retryScan,
  submitScan,
} from "./scan-repository.ts";
import { getOrCreateUserIdByClerkId } from "./user-repository.ts";
import {
  accountDeletions,
  albums,
  batches,
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

const scanConnectionString = process.env.SCAN_DATABASE_URL;
const coreConnectionString = process.env.CORE_DATABASE_URL;

if (!scanConnectionString || !coreConnectionString) {
  throw new Error(
    "SCAN_DATABASE_URL and CORE_DATABASE_URL are required for database integration tests.",
  );
}

const scanDatabase = createScanDatabase({
  connectionString: scanConnectionString,
  maxConnections: 2,
});
const coreDatabase = createCoreDatabase({
  connectionString: coreConnectionString,
  maxConnections: 2,
});
const userId = randomUUID();

beforeAll(async () => {
  await coreDatabase.db.insert(users).values({ id: userId });
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
      scanDatabase.db,
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

/**
 * P4.2 Task 7 (ADR-0030): deleting a `core.users` row no longer removes that
 * user's `scan` rows. Migration 022 dropped `scans`/`batches`/
 * `scan_confirmations`'s `user_id` foreign keys -- no cross-schema
 * constraint can survive the split -- and production replaces that cascade
 * with `deleteScanDataForUser`'s explicit, ordered delete inside the
 * account-deletion workflow (`account-repository.ts`). Tests that tear an
 * account down directly, rather than through `deleteAccount`, need the same
 * scan-side delete: without it every run leaves its scans and pending
 * confirmations behind forever, and the next run's
 * `listStalePendingConfirmations` assertions -- which query the whole table,
 * not one user's rows -- see the previous run's. Unconditional, unlike the
 * production version, which refuses while a confirmation is still pending:
 * test cleanup must always clear, including mid-drain.
 */
async function deleteTestAccount(accountId: string) {
  await scanDatabase.db
    .delete(scanConfirmations)
    .where(eq(scanConfirmations.userId, accountId));
  await scanDatabase.db.delete(scans).where(eq(scans.userId, accountId));
  await scanDatabase.db.delete(batches).where(eq(batches.userId, accountId));
  await scanDatabase.db
    .delete(accountDeletions)
    .where(eq(accountDeletions.userId, accountId));
  await coreDatabase.db.delete(users).where(eq(users.id, accountId));
}

afterAll(async () => {
  await deleteTestAccount(userId);
  await Promise.all([scanDatabase.close(), coreDatabase.close()]);
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
  input: Parameters<typeof confirmScan>[2],
): ReturnType<typeof confirmScan> {
  const result = await confirmScan(scanDatabase.db, coreDatabase.db, input);
  if (result.record.status === "completed") {
    return result;
  }

  // Both tables key on `confirmationEventId(scanId, idempotencyKey)`, not
  // scanId alone (ADR-0018 lets one scan be confirmed, completed, removed,
  // and reconfirmed more than once), so filtering on the exact composite key
  // finds this specific attempt's row even if the scan has older ones.
  const eventKey = confirmationEventId(input.scanId, input.idempotencyKey);
  const [outboxRow] = await scanDatabase.db
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
  await processScanConfirmation(coreDatabase.db, confirmedEvent);

  const [receipt] = await coreDatabase.db
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
  await applyConfirmationCompletion(scanDatabase.db, completedEvent);

  const final = await confirmScan(scanDatabase.db, coreDatabase.db, input);
  return { record: final.record, created: result.created };
}

describe("initial scan persistence schema", () => {
  it("replays idempotent scan and upload commands without duplicate rows", async () => {
    const scanInput = {
      userId,
      source: "single_upload" as const,
      idempotencyKey: `repository-scan-${randomUUID()}`,
    };
    const createdScan = await createOrGetScan(scanDatabase.db, scanInput);
    const replayedScan = await createOrGetScan(scanDatabase.db, scanInput);

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
      scanDatabase.db,
      uploadInput,
    );
    const replayedUpload = await createOrGetImageUpload(
      scanDatabase.db,
      uploadInput,
    );

    expect(createdUpload.created).toBe(true);
    expect(replayedUpload.created).toBe(false);
    expect(replayedUpload.record.id).toBe(createdUpload.record.id);
  });

  it("stores a scan, completed image, and attempt audit row", async () => {
    const [scan] = await scanDatabase.db
      .insert(scans)
      .values({
        userId,
        source: "camera",
        idempotencyKey: `scan-${randomUUID()}`,
      })
      .returning();

    expect(scan?.status).toBe("awaiting_upload");

    await scanDatabase.db.insert(imageAssets).values({
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

    await scanDatabase.db.insert(scanAttempts).values({
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

    const stored = await scanDatabase.db.query.scans.findFirst({
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
    const scan = await createOrGetScan(scanDatabase.db, {
      userId,
      source: "single_upload",
      idempotencyKey: `submit-scan-${randomUUID()}`,
    });
    const upload = await createOrGetImageUpload(scanDatabase.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey: `submit-upload-${randomUUID()}`,
      filename: "front.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1_024,
      checksumSha256: "c".repeat(64),
      maxImages: 12,
    });
    await completeImageUpload(scanDatabase.db, {
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
    const submitted = await submitScan(scanDatabase.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey,
    });
    const replayed = await submitScan(scanDatabase.db, {
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

    const storedMessages = await scanDatabase.db
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
      scanDatabase.db,
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
      scanDatabase.db,
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

    const [publishedMessage] = await scanDatabase.db
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
    const scan = await createOrGetScan(scanDatabase.db, {
      userId,
      source: "single_upload",
      idempotencyKey: `correlation-scan-${randomUUID()}`,
    });
    const upload = await createOrGetImageUpload(scanDatabase.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey: `correlation-upload-${randomUUID()}`,
      filename: "front.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1_024,
      checksumSha256: "d".repeat(64),
      maxImages: 12,
    });
    await completeImageUpload(scanDatabase.db, {
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
    const submitted = await submitScan(scanDatabase.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey: `correlation-submit-${randomUUID()}`,
      correlationId,
    });
    expect(submitted.job.correlationId).toBe(correlationId);

    const [storedMessage] = await scanDatabase.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.aggregateId, scan.record.id));
    expect(storedMessage).toMatchObject({ correlationId });

    const prepared = await prepareScanAnalysis(scanDatabase.db, {
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

    const [attemptRow] = await scanDatabase.db
      .select()
      .from(scanAttempts)
      .where(eq(scanAttempts.id, prepared.attemptId));
    expect(attemptRow).toMatchObject({ correlationId });
  });

  it("rejects a submission that exceeds the per-user daily analysis quota", async () => {
    const quotaUserId = randomUUID();
    await coreDatabase.db.insert(users).values({ id: quotaUserId });
    const createCompletedScan = async () => {
      const scan = await createOrGetScan(scanDatabase.db, {
        userId: quotaUserId,
        source: "single_upload",
        idempotencyKey: `quota-scan-${randomUUID()}`,
      });
      const upload = await createOrGetImageUpload(scanDatabase.db, {
        userId: quotaUserId,
        scanId: scan.record.id,
        idempotencyKey: `quota-upload-${randomUUID()}`,
        filename: "front.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 512,
        checksumSha256: "b".repeat(64),
        maxImages: 12,
      });
      await completeImageUpload(scanDatabase.db, {
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
    await submitScan(scanDatabase.db, {
      userId: quotaUserId,
      scanId: first,
      idempotencyKey: `quota-submit-${randomUUID()}`,
    });
    const second = await createCompletedScan();

    await expect(
      submitScan(scanDatabase.db, {
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

    await deleteTestAccount(quotaUserId);
  });

  it("reports advisory quota headroom that reflects active scans", async () => {
    const headroomUserId = randomUUID();
    await coreDatabase.db.insert(users).values({ id: headroomUserId });

    const fresh = await getScanQuotaHeadroomForUser(scanDatabase.db, {
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

    const scan = await createOrGetScan(scanDatabase.db, {
      userId: headroomUserId,
      source: "single_upload",
      idempotencyKey: `headroom-scan-${randomUUID()}`,
    });
    const upload = await createOrGetImageUpload(scanDatabase.db, {
      userId: headroomUserId,
      scanId: scan.record.id,
      idempotencyKey: `headroom-upload-${randomUUID()}`,
      filename: "front.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 512,
      checksumSha256: "c".repeat(64),
      maxImages: 12,
    });
    await completeImageUpload(scanDatabase.db, {
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
    await submitScan(scanDatabase.db, {
      userId: headroomUserId,
      scanId: scan.record.id,
      idempotencyKey: `headroom-submit-${randomUUID()}`,
    });

    const afterSubmit = await getScanQuotaHeadroomForUser(scanDatabase.db, {
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

    await deleteTestAccount(headroomUserId);
  });

  it("rejects creating a new scan before any upload work when the active-scan limit is already exhausted", async () => {
    const admissionUserId = randomUUID();
    await coreDatabase.db.insert(users).values({ id: admissionUserId });

    const active = await createOrGetScan(scanDatabase.db, {
      userId: admissionUserId,
      source: "single_upload",
      idempotencyKey: `admission-scan-active-${randomUUID()}`,
    });
    const activeUpload = await createOrGetImageUpload(scanDatabase.db, {
      userId: admissionUserId,
      scanId: active.record.id,
      idempotencyKey: `admission-upload-${randomUUID()}`,
      filename: "front.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 512,
      checksumSha256: "d".repeat(64),
      maxImages: 12,
    });
    await completeImageUpload(scanDatabase.db, {
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
    await submitScan(scanDatabase.db, {
      userId: admissionUserId,
      scanId: active.record.id,
      idempotencyKey: `admission-submit-${randomUUID()}`,
    });

    const blockedIdempotencyKey = `admission-scan-blocked-${randomUUID()}`;
    await expect(
      createOrGetScan(scanDatabase.db, {
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

    const blockedScan = await scanDatabase.db.query.scans.findFirst({
      where: eq(scans.idempotencyKey, blockedIdempotencyKey),
    });
    expect(blockedScan).toBeUndefined();

    await deleteTestAccount(admissionUserId);
  });

  it("cancels an abandoned awaiting_upload scan and leaves a recent one untouched", async () => {
    const cleanupUserId = randomUUID();
    await coreDatabase.db.insert(users).values({ id: cleanupUserId });

    const abandoned = await createOrGetScan(scanDatabase.db, {
      userId: cleanupUserId,
      source: "single_upload",
      idempotencyKey: `cleanup-scan-abandoned-${randomUUID()}`,
    });
    const abandonedUpload = await createOrGetImageUpload(scanDatabase.db, {
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
    await scanDatabase.db
      .update(scans)
      .set({ createdAt: staleTimestamp, updatedAt: staleTimestamp })
      .where(eq(scans.id, abandoned.record.id));
    await scanDatabase.db
      .update(imageAssets)
      .set({ createdAt: staleTimestamp })
      .where(eq(imageAssets.id, abandonedUpload.record.id));

    const recent = await createOrGetScan(scanDatabase.db, {
      userId: cleanupUserId,
      source: "single_upload",
      idempotencyKey: `cleanup-scan-recent-${randomUUID()}`,
    });

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    const canceled = await cleanupAbandonedScans(scanDatabase.db, {
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
      scanDatabase.db.query.scans.findFirst({
        where: eq(scans.id, abandoned.record.id),
      }),
      scanDatabase.db.query.scans.findFirst({
        where: eq(scans.id, recent.record.id),
      }),
    ]);
    expect(abandonedStatus?.status).toBe("canceled");
    expect(recentStatus?.status).toBe("awaiting_upload");

    await deleteTestAccount(cleanupUserId);
  });

  it("enforces per-user idempotency keys", async () => {
    const idempotencyKey = `duplicate-${randomUUID()}`;
    await scanDatabase.db.insert(scans).values({
      userId,
      source: "single_upload",
      idempotencyKey,
    });

    await expect(
      scanDatabase.db.insert(scans).values({
        userId,
        source: "single_upload",
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("rejects malformed checksums and invalid attempt numbers", async () => {
    const [scan] = await scanDatabase.db
      .insert(scans)
      .values({
        userId,
        source: "single_upload",
        idempotencyKey: `constraints-${randomUUID()}`,
      })
      .returning();

    await expect(
      scanDatabase.db.insert(imageAssets).values({
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
      scanDatabase.db.insert(scanAttempts).values({
        scanId: scan!.id,
        attemptNumber: 0,
        status: "processing",
        model: "integration-test-model",
        promptVersion: "integration-test.v1",
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("confirms a reviewed result idempotently and converts a wishlist item", async () => {
    const [scan] = await scanDatabase.db
      .insert(scans)
      .values({
        userId,
        source: "camera",
        status: "needs_review",
        idempotencyKey: `confirm-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    const [attempt] = await scanDatabase.db
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
    const [candidate] = await scanDatabase.db
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
    const replayed = await confirmScan(
      scanDatabase.db,
      coreDatabase.db,
      confirmation,
    );

    expect(created.created).toBe(true);
    expect(replayed.created).toBe(false);
    expect(replayed.record).toEqual(created.record);
    expect(created.record).toMatchObject({
      scanId: scan!.id,
      selectedCandidateId: candidate!.id,
      libraryItem: { list: "wishlist" },
      release: { artist: "Miles Davis", title: "Kind of Blue" },
    });

    const [secondScan] = await scanDatabase.db
      .insert(scans)
      .values({
        userId,
        source: "single_upload",
        status: "identified",
        idempotencyKey: `confirm-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    await scanDatabase.db.insert(scanAttempts).values({
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
    const [thirdScan] = await scanDatabase.db
      .insert(scans)
      .values({
        userId,
        source: "single_upload",
        status: "identified",
        idempotencyKey: `confirm-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    await scanDatabase.db.insert(scanAttempts).values({
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
      getScanForUser(scanDatabase.db, coreDatabase.db, {
        userId,
        scanId: secondScan!.id,
      }),
    ).resolves.toMatchObject({
      confirmation: {
        release: { artist: "MILES DAVIS", title: "Kind of Blue" },
        libraryItem: { list: "collection" },
      },
    });
    await expect(
      listLibraryItemsForUser(coreDatabase.db, scanDatabase.db, {
        userId,
        list: "collection",
      }),
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
      await coreDatabase.db
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
      await coreDatabase.db
        .select()
        .from(catalogReferences)
        .where(eq(catalogReferences.provider, "musicbrainz")),
    ).toHaveLength(2);
    expect(
      await coreDatabase.db
        .select()
        .from(libraryCopies)
        .where(eq(libraryCopies.libraryItemId, created.record.libraryItem!.id)),
    ).toHaveLength(2);
    expect(
      await coreDatabase.db
        .select()
        .from(libraryItems)
        .where(eq(libraryItems.userId, userId)),
    ).toHaveLength(1);
    expect(
      await scanDatabase.db
        .select()
        .from(scanConfirmations)
        .where(eq(scanConfirmations.userId, userId)),
    ).toHaveLength(3);

    await expect(
      confirmScan(scanDatabase.db, coreDatabase.db, {
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
    const [scan] = await scanDatabase.db
      .insert(scans)
      .values({
        userId,
        source: "single_upload",
        status: "identified",
        idempotencyKey: `confirm-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    await scanDatabase.db.insert(scanAttempts).values({
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

    const updated = await updateLibraryItem(coreDatabase.db, scanDatabase.db, {
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

    const updated = await updateLibraryItem(coreDatabase.db, scanDatabase.db, {
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
      updateLibraryItem(coreDatabase.db, scanDatabase.db, {
        userId,
        itemId,
        update: { list: "wishlist" },
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("rejects updating a library item owned by another user", async () => {
    const itemId = await confirmWishlistItem("wishlist");

    await expect(
      updateLibraryItem(coreDatabase.db, scanDatabase.db, {
        userId: randomUUID(),
        itemId,
        update: { notes: "not mine" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("deletes an item with scan history while keeping its confirmation audit row", async () => {
    const itemId = await confirmWishlistItem("collection");
    const [confirmationBefore] = await scanDatabase.db
      .select()
      .from(scanConfirmations)
      .where(eq(scanConfirmations.libraryItemId, itemId));
    expect(confirmationBefore).toBeDefined();
    const scanId = confirmationBefore!.scanId;

    const deleted = await deleteLibraryItem(coreDatabase.db, scanDatabase.db, {
      userId,
      itemId,
    });
    expect(deleted).toEqual({ id: itemId });
    expect(
      await coreDatabase.db
        .select()
        .from(libraryItems)
        .where(eq(libraryItems.id, itemId)),
    ).toHaveLength(0);

    // The decision survives with its reviewed snapshot; only the pointer to the
    // removed item is cleared (ADR-0018).
    const [confirmationAfter] = await scanDatabase.db
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
      await getScanConfirmationForUser(scanDatabase.db, coreDatabase.db, {
        userId,
        scanId,
      }),
    ).toBeNull();
  });

  it("deletes a library item with no confirmation history and cascades its copies", async () => {
    const [album] = await coreDatabase.db
      .insert(albums)
      .values({
        artist: `Directly Added Artist ${randomUUID()}`,
        title: "Directly Added Title",
        normalizedArtist: `directly added artist ${randomUUID()}`,
        normalizedTitle: "directly added title",
      })
      .returning();
    const [directRelease] = await coreDatabase.db
      .insert(releases)
      .values({
        albumId: album!.id,
        identityKey: randomUUID().replace(/-/g, "").padEnd(64, "0"),
      })
      .returning();
    const [item] = await coreDatabase.db
      .insert(libraryItems)
      .values({
        userId,
        releaseId: directRelease!.id,
        list: "wishlist",
      })
      .returning();

    const deleted = await deleteLibraryItem(coreDatabase.db, scanDatabase.db, {
      userId,
      itemId: item!.id,
    });
    expect(deleted).toEqual({ id: item!.id });

    await expect(
      deleteLibraryItem(coreDatabase.db, scanDatabase.db, {
        userId,
        itemId: item!.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("saves a scan again after its item was removed, replacing the old decision", async () => {
    const itemId = await confirmWishlistItem("wishlist");
    const [confirmation] = await scanDatabase.db
      .select()
      .from(scanConfirmations)
      .where(eq(scanConfirmations.libraryItemId, itemId));
    const scanId = confirmation!.scanId;
    await deleteLibraryItem(coreDatabase.db, scanDatabase.db, {
      userId,
      itemId,
    });

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
    const [scan] = await scanDatabase.db
      .insert(scans)
      .values({
        userId,
        source: "single_upload",
        status: "identified",
        idempotencyKey: `cover-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    await scanDatabase.db.insert(scanAttempts).values({
      scanId: scan!.id,
      attemptNumber: 1,
      status: "succeeded",
      model: "integration-test-model",
      promptVersion: "integration-test.v1",
      providerResponseId: `response-${randomUUID()}`,
      durationMs: 20,
      completedAt: new Date(),
    });
    const [cover] = await scanDatabase.db
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

    const item = await getLibraryItemForUser(coreDatabase.db, scanDatabase.db, {
      userId,
      itemId: confirmed.record.libraryItem!.id,
    });
    expect(item.coverImage).toEqual({
      scanId: scan!.id,
      imageId: cover!.id,
    });

    await expect(
      getLibraryItemForUser(coreDatabase.db, scanDatabase.db, {
        userId,
        itemId: randomUUID(),
      }),
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

    const matched = await listLibraryItemsForUser(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId,
        list: "wishlist",
        query: `miles davis search test ${suffix}`,
      },
    );
    expect(matched.items.map((item) => item.id)).toEqual([milesId]);

    const byTitle = await listLibraryItemsForUser(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId,
        list: "wishlist",
        query: `love supreme ${suffix}`,
      },
    );
    expect(byTitle.items.map((item) => item.id)).toEqual([johnId]);

    const sortedByArtist = await listLibraryItemsForUser(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId,
        list: "wishlist",
        query: `search test ${suffix}`,
        sort: "artist",
      },
    );
    expect(sortedByArtist.items.map((item) => item.id)).toEqual([
      johnId,
      milesId,
    ]);

    const noMatches = await listLibraryItemsForUser(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId,
        list: "wishlist",
        query: `no such artist ${suffix}`,
      },
    );
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
    const [scan] = await scanDatabase.db
      .insert(scans)
      .values({
        userId: owner,
        source: "single_upload",
        status: "identified",
        idempotencyKey: `copy-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    await scanDatabase.db.insert(scanAttempts).values({
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
    const before = await getLibraryItemForUser(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId,
        itemId,
      },
    );
    const update = {
      mediaCondition: "very_good_plus" as const,
      sleeveCondition: "very_good" as const,
      location: "Shelf B",
      notes: "Insert included",
      acquiredAt: "2026-08-30",
    };

    const edited = await updateLibraryCopy(coreDatabase.db, {
      userId,
      itemId,
      copyId,
      update,
    });
    expect(edited).toMatchObject({ id: copyId, ...update });

    // Idempotent by identity: the same body again changes nothing.
    const replayed = await updateLibraryCopy(coreDatabase.db, {
      userId,
      itemId,
      copyId,
      update,
    });
    expect(replayed).toMatchObject({ id: copyId, ...update });

    // A partial update touches only the named field.
    const cleared = await updateLibraryCopy(coreDatabase.db, {
      userId,
      itemId,
      copyId,
      update: { location: null },
    });
    expect(cleared).toMatchObject({ ...update, location: null });

    const after = await getLibraryItemForUser(
      coreDatabase.db,
      scanDatabase.db,
      { userId, itemId },
    );
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
    await coreDatabase.db.insert(users).values({ id: strangerId });
    const stranger = await confirmOwnedRecord(strangerId);

    // Another user's copy, named with its own record: not found, unchanged.
    await expect(
      updateLibraryCopy(coreDatabase.db, {
        userId,
        itemId: stranger.itemId,
        copyId: stranger.copyId,
        update: { location: "Not mine" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      deleteLibraryCopy(coreDatabase.db, scanDatabase.db, {
        userId,
        itemId: stranger.itemId,
        copyId: stranger.copyId,
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    // My own copy addressed through a different record of mine: the copy
    // belongs to exactly one record, so the pair does not resolve.
    await expect(
      updateLibraryCopy(coreDatabase.db, {
        userId,
        itemId: other.itemId,
        copyId: mine.copyId,
        update: { location: "Wrong record" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      deleteLibraryCopy(coreDatabase.db, scanDatabase.db, {
        userId,
        itemId: other.itemId,
        copyId: mine.copyId,
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    // A stranger addressing my record and copy correctly still gets nothing.
    await expect(
      createLibraryCopy(coreDatabase.db, {
        userId: strangerId,
        itemId: mine.itemId,
        idempotencyKey: `stranger-${randomUUID()}`,
        copy: blankCopy,
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    const [untouched] = await coreDatabase.db
      .select()
      .from(libraryCopies)
      .where(eq(libraryCopies.id, stranger.copyId));
    expect(untouched).toMatchObject({ id: stranger.copyId, location: null });
    expect(
      (
        await getLibraryItemForUser(coreDatabase.db, scanDatabase.db, {
          userId,
          itemId: mine.itemId,
        })
      ).copies,
    ).toHaveLength(1);
    await deleteTestAccount(strangerId);
  });

  it("removes a copy while its confirmation keeps every audit field", async () => {
    const { scanId, itemId, copyId } = await confirmOwnedRecord();
    const [before] = await scanDatabase.db
      .select()
      .from(scanConfirmations)
      .where(eq(scanConfirmations.scanId, scanId));
    expect(before).toMatchObject({ libraryItemId: itemId, copyId });

    expect(
      await deleteLibraryCopy(coreDatabase.db, scanDatabase.db, {
        userId,
        itemId,
        copyId,
      }),
    ).toEqual({ id: copyId });

    // The decision survives intact; only the pointer to the removed copy
    // clears, and the scan still reads as confirmed into this record.
    const [after] = await scanDatabase.db
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
    const summary = await getScanConfirmationForUser(
      scanDatabase.db,
      coreDatabase.db,
      {
        userId,
        scanId,
      },
    );
    expect(summary).toMatchObject({
      libraryItem: { id: itemId, list: "collection", copy: null },
    });

    // Removing it again is not found, like removing a record twice.
    await expect(
      deleteLibraryCopy(coreDatabase.db, scanDatabase.db, {
        userId,
        itemId,
        copyId,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps a record in the collection with no copies after its last copy is removed, until the user moves it", async () => {
    const { itemId, copyId } = await confirmOwnedRecord();
    await deleteLibraryCopy(coreDatabase.db, scanDatabase.db, {
      userId,
      itemId,
      copyId,
    });

    // The list is the user's statement; clearing inventory does not change it.
    const emptied = await getLibraryItemForUser(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId,
        itemId,
      },
    );
    expect(emptied).toMatchObject({ list: "collection", copyCount: 0 });
    expect(emptied.copies).toEqual([]);
    const page = await listLibraryItemsForUser(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId,
        list: "collection",
        query: emptied.release.artist,
      },
    );
    expect(page.items.map((item) => item.id)).toEqual([itemId]);

    // From here the ADR-0011 move applies with nothing to orphan, and moving
    // back records a first copy again.
    const wished = await updateLibraryItem(coreDatabase.db, scanDatabase.db, {
      userId,
      itemId,
      update: { list: "wishlist" },
    });
    expect(wished).toMatchObject({ list: "wishlist", copyCount: 0 });
    const owned = await updateLibraryItem(coreDatabase.db, scanDatabase.db, {
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
    const before = await getLibraryItemForUser(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId,
        itemId,
      },
    );
    const key = `copy-${randomUUID()}`;
    const details = {
      ...blankCopy,
      mediaCondition: "near_mint" as const,
      location: "Shelf C",
    };

    const first = await createLibraryCopy(coreDatabase.db, {
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
    const replay = await createLibraryCopy(coreDatabase.db, {
      userId,
      itemId,
      idempotencyKey: key,
      copy: details,
    });
    expect(replay).toEqual({ copy: first.copy, created: false });

    // The same key with a different body, or for a different record, is a
    // conflict rather than a silent second copy.
    await expect(
      createLibraryCopy(coreDatabase.db, {
        userId,
        itemId,
        idempotencyKey: key,
        copy: { ...details, location: "Shelf D" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      createLibraryCopy(coreDatabase.db, {
        userId,
        itemId: other.itemId,
        idempotencyKey: key,
        copy: details,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    // A different key records a genuinely distinct copy, blank or not.
    const second = await createLibraryCopy(coreDatabase.db, {
      userId,
      itemId,
      idempotencyKey: `copy-${randomUUID()}`,
      copy: blankCopy,
    });
    expect(second.created).toBe(true);
    expect(second.copy.id).not.toBe(first.copy.id);

    const after = await getLibraryItemForUser(
      coreDatabase.db,
      scanDatabase.db,
      { userId, itemId },
    );
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
        await getLibraryItemForUser(coreDatabase.db, scanDatabase.db, {
          userId,
          itemId: other.itemId,
        })
      ).copyCount,
    ).toBe(1);
  });

  it("rejects a copy on a wishlist record and past the per-record cap", async () => {
    const { itemId, copyId } = await confirmOwnedRecord();
    await deleteLibraryCopy(coreDatabase.db, scanDatabase.db, {
      userId,
      itemId,
      copyId,
    });
    await updateLibraryItem(coreDatabase.db, scanDatabase.db, {
      userId,
      itemId,
      update: { list: "wishlist" },
    });
    await expect(
      createLibraryCopy(coreDatabase.db, {
        userId,
        itemId,
        idempotencyKey: `copy-${randomUUID()}`,
        copy: blankCopy,
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });

    const owned = await updateLibraryItem(coreDatabase.db, scanDatabase.db, {
      userId,
      itemId,
      update: { list: "collection" },
    });
    await coreDatabase.db.insert(libraryCopies).values(
      Array.from({ length: MAX_LIBRARY_COPIES_PER_ITEM - 1 }, () => ({
        userId,
        libraryItemId: itemId,
        releaseId: owned.release.id,
      })),
    );
    await expect(
      createLibraryCopy(coreDatabase.db, {
        userId,
        itemId,
        idempotencyKey: `copy-${randomUUID()}`,
        copy: blankCopy,
      }),
    ).rejects.toMatchObject({ code: "library_copy_limit" });
    const full = await getLibraryItemForUser(coreDatabase.db, scanDatabase.db, {
      userId,
      itemId,
    });
    expect(full.copyCount).toBe(MAX_LIBRARY_COPIES_PER_ITEM);
    expect(full.copies).toHaveLength(MAX_LIBRARY_COPIES_PER_ITEM);
  });
});

describe("batch grouping and scan lifecycle", () => {
  it("groups independent scans under one batch and projects their status", async () => {
    const batch = await createOrGetBatch(scanDatabase.db, {
      userId,
      idempotencyKey: `batch-${randomUUID()}`,
    });
    const replayedBatch = await createOrGetBatch(scanDatabase.db, {
      userId,
      idempotencyKey: batch.record.idempotencyKey,
    });
    expect(batch.created).toBe(true);
    expect(replayedBatch.created).toBe(false);
    expect(replayedBatch.record.id).toBe(batch.record.id);

    const first = await createOrGetScan(scanDatabase.db, {
      userId,
      source: "single_upload",
      idempotencyKey: `batch-scan-1-${randomUUID()}`,
      batchId: batch.record.id,
    });
    const second = await createOrGetScan(scanDatabase.db, {
      userId,
      source: "single_upload",
      idempotencyKey: `batch-scan-2-${randomUUID()}`,
      batchId: batch.record.id,
    });
    expect(first.record.batchId).toBe(batch.record.id);
    expect(second.record.batchId).toBe(batch.record.id);

    const { batch: loadedBatch, scanIds } = await getBatchForUser(
      scanDatabase.db,
      {
        userId,
        batchId: batch.record.id,
      },
    );
    expect(loadedBatch.id).toBe(batch.record.id);
    expect(scanIds).toEqual([first.record.id, second.record.id]);

    const summaries = await listScanSummariesForUser(
      scanDatabase.db,
      coreDatabase.db,
      {
        userId,
        scanIds,
      },
    );
    expect(summaries.map((summary) => summary.status)).toEqual([
      "awaiting_upload",
      "awaiting_upload",
    ]);

    await expect(
      createOrGetScan(scanDatabase.db, {
        userId,
        source: "single_upload",
        idempotencyKey: `batch-scan-missing-${randomUUID()}`,
        batchId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("enforces the server-side batch limit while allowing idempotent replay", async () => {
    const batch = await createOrGetBatch(scanDatabase.db, {
      userId,
      idempotencyKey: `limited-batch-${randomUUID()}`,
    });
    const scanKeys = Array.from(
      { length: MAX_SCANS_PER_BATCH },
      (_, index) => `limited-batch-scan-${index}-${randomUUID()}`,
    );

    for (const idempotencyKey of scanKeys) {
      await createOrGetScan(scanDatabase.db, {
        userId,
        source: "batch_upload",
        idempotencyKey,
        batchId: batch.record.id,
      });
    }

    await expect(
      createOrGetScan(scanDatabase.db, {
        userId,
        source: "batch_upload",
        idempotencyKey: scanKeys[0]!,
        batchId: batch.record.id,
      }),
    ).resolves.toMatchObject({ created: false });
    await expect(
      createOrGetScan(scanDatabase.db, {
        userId,
        source: "batch_upload",
        idempotencyKey: `over-limit-${randomUUID()}`,
        batchId: batch.record.id,
      }),
    ).rejects.toMatchObject({ code: "batch_scan_limit" });
  });

  it("falls back to the original object for images completed before normalization", async () => {
    const scan = await createOrGetScan(scanDatabase.db, {
      userId,
      source: "single_upload",
      idempotencyKey: `legacy-scan-${randomUUID()}`,
    });
    const upload = await createOrGetImageUpload(scanDatabase.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey: `legacy-upload-${randomUUID()}`,
      filename: "legacy-front.png",
      mimeType: "image/png",
      sizeBytes: 512,
      checksumSha256: "9".repeat(64),
      maxImages: 12,
    });
    await scanDatabase.db
      .update(imageAssets)
      .set({ completedAt: new Date(), width: 800, height: 600 })
      .where(eq(imageAssets.id, upload.record.id));
    const submitted = await submitScan(scanDatabase.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey: `legacy-submit-${randomUUID()}`,
    });

    const prepared = await prepareScanAnalysis(scanDatabase.db, {
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
    await coreDatabase.db.insert(users).values({ id: usageUserId });

    const batch = await createOrGetBatch(scanDatabase.db, {
      userId: usageUserId,
      idempotencyKey: `usage-batch-${randomUUID()}`,
    });
    const succeededScan = await createOrGetScan(scanDatabase.db, {
      userId: usageUserId,
      source: "single_upload",
      idempotencyKey: `usage-scan-succeeded-${randomUUID()}`,
      batchId: batch.record.id,
    });
    const failedScan = await createOrGetScan(scanDatabase.db, {
      userId: usageUserId,
      source: "single_upload",
      idempotencyKey: `usage-scan-failed-${randomUUID()}`,
      batchId: batch.record.id,
    });
    const otherScan = await createOrGetScan(scanDatabase.db, {
      userId: usageUserId,
      source: "single_upload",
      idempotencyKey: `usage-scan-other-${randomUUID()}`,
    });

    await scanDatabase.db
      .update(scans)
      .set({ status: "identified", completedAt: new Date() })
      .where(eq(scans.id, succeededScan.record.id));
    await scanDatabase.db.insert(scanAttempts).values({
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

    await scanDatabase.db
      .update(scans)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(scans.id, failedScan.record.id));
    await scanDatabase.db.insert(scanAttempts).values({
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

    await scanDatabase.db
      .update(scans)
      .set({ status: "identified", completedAt: new Date() })
      .where(eq(scans.id, otherScan.record.id));
    await scanDatabase.db.insert(scanAttempts).values({
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

    const batchCost = await getBatchCostSummary(scanDatabase.db, {
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

    const usage = await getUsageSummaryForUser(scanDatabase.db, {
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

    await deleteTestAccount(usageUserId);
  });

  it("retries a failed scan as a new attempt and rejects retrying an active scan", async () => {
    const scan = await createOrGetScan(scanDatabase.db, {
      userId,
      source: "single_upload",
      idempotencyKey: `retry-scan-${randomUUID()}`,
    });
    const upload = await createOrGetImageUpload(scanDatabase.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey: `retry-upload-${randomUUID()}`,
      filename: "front.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 512,
      checksumSha256: "e".repeat(64),
      maxImages: 12,
    });
    await completeImageUpload(scanDatabase.db, {
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
      retryScan(scanDatabase.db, { userId, scanId: scan.record.id }),
    ).rejects.toMatchObject({ code: "invalid_state" });

    await scanDatabase.db
      .update(scans)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(scans.id, scan.record.id));
    await scanDatabase.db.insert(scanAttempts).values({
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

    const retried = await retryScan(scanDatabase.db, {
      userId,
      scanId: scan.record.id,
    });
    expect(retried.created).toBe(true);
    expect(retried.job.attemptNumber).toBe(2);
    expect(retried.record.status).toBe("queued");

    const replayedRetry = await retryScan(scanDatabase.db, {
      userId,
      scanId: scan.record.id,
    });
    expect(replayedRetry.created).toBe(false);
    expect(replayedRetry.jobId).toBe(retried.jobId);
  });

  it("cancels a queued scan and skips its outbox dispatch", async () => {
    const scan = await createOrGetScan(scanDatabase.db, {
      userId,
      source: "single_upload",
      idempotencyKey: `cancel-scan-${randomUUID()}`,
    });
    const upload = await createOrGetImageUpload(scanDatabase.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey: `cancel-upload-${randomUUID()}`,
      filename: "front.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 512,
      checksumSha256: "f".repeat(64),
      maxImages: 12,
    });
    await completeImageUpload(scanDatabase.db, {
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
    const submitted = await submitScan(scanDatabase.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey: `cancel-submit-${randomUUID()}`,
    });

    const canceled = await cancelScan(scanDatabase.db, {
      userId,
      scanId: scan.record.id,
    });
    expect(canceled.created).toBe(true);
    expect(canceled.record.status).toBe("canceled");

    const replayedCancel = await cancelScan(scanDatabase.db, {
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
      cancelScan(scanDatabase.db, { userId, scanId: scan.record.id }),
    ).resolves.toMatchObject({ created: false });
  });

  it("dispatches a non-analysis topic without a scan foreign key, a mandatory attempt number, or the cancellation skip (P4.2 Task 2)", async () => {
    // A canceled scan proves the cancellation skip is scoped to
    // scan.analyze.v1: a different topic naming this same canceled scan as
    // its aggregate must still be delivered normally.
    const canceledScan = await createOrGetScan(scanDatabase.db, {
      userId,
      source: "single_upload",
      idempotencyKey: `generalized-outbox-scan-${randomUUID()}`,
    });
    await cancelScan(scanDatabase.db, {
      userId,
      scanId: canceledScan.record.id,
    });

    const genericTopic = "core.library_export.v1";
    const scanAggregateKey = `generalized-outbox-scan-aggregate-${randomUUID()}`;
    const orphanAggregateId = randomUUID();
    const orphanAggregateKey = `generalized-outbox-orphan-aggregate-${randomUUID()}`;

    // No FK on aggregate_id: this second row's aggregate_id matches no row
    // in any table at all, which the old scans(id) foreign key would have
    // rejected outright.
    await scanDatabase.db.insert(outboxMessages).values([
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
    const stored = await scanDatabase.db
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
          scanDatabase.db,
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
    const [scan] = await scanDatabase.db
      .insert(scans)
      .values({
        userId,
        source: "single_upload",
        status: "needs_review",
        idempotencyKey: `dismiss-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    await scanDatabase.db.insert(scanAttempts).values({
      scanId: scan!.id,
      attemptNumber: 1,
      status: "succeeded",
      model: "integration-test-model",
      promptVersion: "integration-test.v1",
      providerResponseId: `response-${randomUUID()}`,
      durationMs: 15,
      completedAt: new Date(),
    });

    const summariesBeforeDismiss = await listScanSummariesForUser(
      scanDatabase.db,
      coreDatabase.db,
      {
        userId,
        scanIds: [scan!.id],
      },
    );
    expect(summariesBeforeDismiss[0]).toMatchObject({
      status: "needs_review",
      confirmedList: null,
    });

    const dismissed = await cancelScan(scanDatabase.db, {
      userId,
      scanId: scan!.id,
    });
    expect(dismissed.created).toBe(true);
    expect(dismissed.record.status).toBe("canceled");

    const replayedDismiss = await cancelScan(scanDatabase.db, {
      userId,
      scanId: scan!.id,
    });
    expect(replayedDismiss.created).toBe(false);
    expect(replayedDismiss.record.status).toBe("canceled");
  });

  it("rejects dismissing a scan that has already been confirmed", async () => {
    const [scan] = await scanDatabase.db
      .insert(scans)
      .values({
        userId,
        source: "single_upload",
        status: "identified",
        idempotencyKey: `dismiss-confirmed-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    const [attempt] = await scanDatabase.db
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
    const [candidate] = await scanDatabase.db
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

    const summaries = await listScanSummariesForUser(
      scanDatabase.db,
      coreDatabase.db,
      {
        userId,
        scanIds: [scan!.id],
      },
    );
    expect(summaries[0]).toMatchObject({ confirmedList: "wishlist" });

    await expect(
      cancelScan(scanDatabase.db, { userId, scanId: scan!.id }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });
});

describe("Clerk user identity resolution", () => {
  it("provisions a new user on first lookup and reuses it thereafter", async () => {
    const clerkUserId = `user_${randomUUID()}`;

    const provisionedId = await getOrCreateUserIdByClerkId(
      coreDatabase.db,
      clerkUserId,
    );
    const reusedId = await getOrCreateUserIdByClerkId(
      coreDatabase.db,
      clerkUserId,
    );

    expect(reusedId).toBe(provisionedId);

    await deleteTestAccount(provisionedId);
  });

  it("resolves concurrent lookups for the same Clerk identity to one user", async () => {
    const clerkUserId = `user_${randomUUID()}`;

    const [first, second] = await Promise.all([
      getOrCreateUserIdByClerkId(coreDatabase.db, clerkUserId),
      getOrCreateUserIdByClerkId(coreDatabase.db, clerkUserId),
    ]);

    expect(second).toBe(first);

    await deleteTestAccount(first);
  });
});

describe("favorites and playlists", () => {
  async function saveRecord(
    list: "collection" | "wishlist",
    ownerId: string = userId,
    title = `Saved Music ${randomUUID()}`,
  ) {
    const { record } = await placeLibraryRelease(coreDatabase.db, {
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

    const first = await updateLibraryItem(coreDatabase.db, scanDatabase.db, {
      userId,
      itemId: owned,
      update: { favorite: true },
    });
    expect(first.favoritedAt).not.toBeNull();
    const repeated = await updateLibraryItem(coreDatabase.db, scanDatabase.db, {
      userId,
      itemId: owned,
      update: { favorite: true },
    });
    // A repeated favorite keeps the original moment rather than resetting it.
    expect(repeated.favoritedAt).toBe(first.favoritedAt);

    await updateLibraryItem(coreDatabase.db, scanDatabase.db, {
      userId,
      itemId: wanted,
      update: { favorite: true },
    });

    const favorites = await listFavoriteLibraryItemsForUser(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId,
      },
    );
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

    const cleared = await updateLibraryItem(coreDatabase.db, scanDatabase.db, {
      userId,
      itemId: owned,
      update: { favorite: false },
    });
    expect(cleared.favoritedAt).toBeNull();
    const clearedAgain = await updateLibraryItem(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId,
        itemId: owned,
        update: { favorite: false },
      },
    );
    expect(clearedAgain.favoritedAt).toBeNull();
    expect(
      (
        await listFavoriteLibraryItemsForUser(
          coreDatabase.db,
          scanDatabase.db,
          { userId },
        )
      ).items.map((item) => item.id),
    ).not.toContain(owned);
  });

  it("creates a playlist once per normalized name and rejects renaming onto another", async () => {
    const suffix = randomUUID();
    const created = await createPlaylist(coreDatabase.db, scanDatabase.db, {
      userId,
      name: `Road Trip ${suffix}`,
    });
    expect(created.created).toBe(true);
    expect(created.playlist.entries).toEqual([]);

    const replayed = await createPlaylist(coreDatabase.db, scanDatabase.db, {
      userId,
      name: `  road   trip ${suffix} `,
    });
    expect(replayed.created).toBe(false);
    expect(replayed.playlist.id).toBe(created.playlist.id);
    // The display name is the one first given, not the replay's spelling.
    expect(replayed.playlist.name).toBe(`Road Trip ${suffix}`);

    const other = await createPlaylist(coreDatabase.db, scanDatabase.db, {
      userId,
      name: `Sunday ${suffix}`,
    });
    await expect(
      updatePlaylist(coreDatabase.db, scanDatabase.db, {
        userId,
        playlistId: other.playlist.id,
        update: { name: `ROAD TRIP ${suffix}` },
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const renamed = await updatePlaylist(coreDatabase.db, scanDatabase.db, {
      userId,
      playlistId: other.playlist.id,
      update: { name: `Sunday morning ${suffix}` },
    });
    expect(renamed.name).toBe(`Sunday morning ${suffix}`);
    // Renaming to its own current name is a harmless replay.
    await expect(
      updatePlaylist(coreDatabase.db, scanDatabase.db, {
        userId,
        playlistId: other.playlist.id,
        update: { name: `Sunday morning ${suffix}` },
      }),
    ).resolves.toMatchObject({ name: `Sunday morning ${suffix}` });

    const listed = await listPlaylistsForUser(coreDatabase.db, { userId });
    expect(listed.playlists.map((playlist) => playlist.id)).toEqual(
      expect.arrayContaining([created.playlist.id, other.playlist.id]),
    );
  });

  it("adds each saved record once, in append order, and never someone else's", async () => {
    const { playlist } = await createPlaylist(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId,
        name: `Append ${randomUUID()}`,
      },
    );
    const first = await saveRecord("collection");
    const second = await saveRecord("wishlist");

    const added = await addPlaylistEntry(coreDatabase.db, scanDatabase.db, {
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

    const replayed = await addPlaylistEntry(coreDatabase.db, scanDatabase.db, {
      userId,
      playlistId: playlist.id,
      libraryItemId: first,
    });
    expect(replayed.created).toBe(false);
    expect(replayed.playlist.entries).toHaveLength(1);

    const appended = await addPlaylistEntry(coreDatabase.db, scanDatabase.db, {
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
    const [stranger] = await coreDatabase.db
      .insert(users)
      .values({})
      .returning();
    const strangerItem = await saveRecord("collection", stranger!.id);
    await expect(
      addPlaylistEntry(coreDatabase.db, scanDatabase.db, {
        userId,
        playlistId: playlist.id,
        libraryItemId: strangerItem,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      getPlaylistForUser(coreDatabase.db, scanDatabase.db, {
        userId: stranger!.id,
        playlistId: playlist.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      addPlaylistEntry(coreDatabase.db, scanDatabase.db, {
        userId: stranger!.id,
        playlistId: playlist.id,
        libraryItemId: strangerItem,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      updatePlaylist(coreDatabase.db, scanDatabase.db, {
        userId: stranger!.id,
        playlistId: playlist.id,
        update: { name: "Hijacked" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      deletePlaylist(coreDatabase.db, {
        userId: stranger!.id,
        playlistId: playlist.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      (await listPlaylistsForUser(coreDatabase.db, { userId: stranger!.id }))
        .playlists,
    ).toEqual([]);
    await deleteTestAccount(stranger!.id);
  });

  it("reorders with a complete permutation and rejects a stale or partial order", async () => {
    const { playlist } = await createPlaylist(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId,
        name: `Reorder ${randomUUID()}`,
      },
    );
    const items = [
      await saveRecord("collection"),
      await saveRecord("collection"),
      await saveRecord("wishlist"),
    ];
    for (const libraryItemId of items) {
      await addPlaylistEntry(coreDatabase.db, scanDatabase.db, {
        userId,
        playlistId: playlist.id,
        libraryItemId,
      });
    }
    const before = await getPlaylistForUser(coreDatabase.db, scanDatabase.db, {
      userId,
      playlistId: playlist.id,
    });
    const [a, b, c] = before.entries.map((entry) => entry.id) as [
      string,
      string,
      string,
    ];

    const reordered = await updatePlaylist(coreDatabase.db, scanDatabase.db, {
      userId,
      playlistId: playlist.id,
      update: { entryIds: [c, a, b] },
    });
    expect(reordered.entries.map((entry) => entry.id)).toEqual([c, a, b]);
    expect(reordered.entries.map((entry) => entry.position)).toEqual([1, 2, 3]);

    // Replaying the same order converges.
    await expect(
      updatePlaylist(coreDatabase.db, scanDatabase.db, {
        userId,
        playlistId: playlist.id,
        update: { entryIds: [c, a, b] },
      }),
    ).resolves.toMatchObject({ entries: [{ id: c }, { id: a }, { id: b }] });

    // A partial order (an entry left out) and an unknown entry are both
    // stale views and are refused rather than partially applied.
    await expect(
      updatePlaylist(coreDatabase.db, scanDatabase.db, {
        userId,
        playlistId: playlist.id,
        update: { entryIds: [c, a] },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      updatePlaylist(coreDatabase.db, scanDatabase.db, {
        userId,
        playlistId: playlist.id,
        update: { entryIds: [c, a, b, randomUUID()] },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const unchanged = await getPlaylistForUser(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId,
        playlistId: playlist.id,
      },
    );
    expect(unchanged.entries.map((entry) => entry.id)).toEqual([c, a, b]);
  });

  it("removes an entry without renumbering and drops entries when the saved record is removed", async () => {
    const { playlist } = await createPlaylist(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId,
        name: `Remove ${randomUUID()}`,
      },
    );
    const first = await saveRecord("collection");
    const second = await saveRecord("wishlist");
    const third = await saveRecord("wishlist");
    for (const libraryItemId of [first, second, third]) {
      await addPlaylistEntry(coreDatabase.db, scanDatabase.db, {
        userId,
        playlistId: playlist.id,
        libraryItemId,
      });
    }
    const detail = await getPlaylistForUser(coreDatabase.db, scanDatabase.db, {
      userId,
      playlistId: playlist.id,
    });
    const secondEntry = detail.entries[1]!;

    const removed = await removePlaylistEntry(coreDatabase.db, {
      userId,
      playlistId: playlist.id,
      entryId: secondEntry.id,
    });
    expect(removed.id).toBe(secondEntry.id);
    await expect(
      removePlaylistEntry(coreDatabase.db, {
        userId,
        playlistId: playlist.id,
        entryId: secondEntry.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    const afterRemove = await getPlaylistForUser(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId,
        playlistId: playlist.id,
      },
    );
    // The gap is kept and the next append goes after the old maximum.
    expect(afterRemove.entries.map((entry) => entry.position)).toEqual([1, 3]);
    const appended = await addPlaylistEntry(coreDatabase.db, scanDatabase.db, {
      userId,
      playlistId: playlist.id,
      libraryItemId: second,
    });
    expect(appended.playlist.entries.map((entry) => entry.position)).toEqual([
      1, 3, 4,
    ]);

    // Removing the saved record removes it from the playlist by cascade.
    await deleteLibraryItem(coreDatabase.db, scanDatabase.db, {
      userId,
      itemId: third,
    });
    const afterItemDelete = await getPlaylistForUser(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId,
        playlistId: playlist.id,
      },
    );
    expect(afterItemDelete.entries.map((entry) => entry.item.id)).toEqual([
      first,
      second,
    ]);

    // Deleting the playlist removes its entries but never the saved records.
    await deletePlaylist(coreDatabase.db, { userId, playlistId: playlist.id });
    await expect(
      getPlaylistForUser(coreDatabase.db, scanDatabase.db, {
        userId,
        playlistId: playlist.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await coreDatabase.db
        .select()
        .from(playlistEntries)
        .where(eq(playlistEntries.playlistId, playlist.id)),
    ).toHaveLength(0);
    await expect(
      getLibraryItemForUser(coreDatabase.db, scanDatabase.db, {
        userId,
        itemId: first,
      }),
    ).resolves.toMatchObject({ id: first });
  });

  it("enforces the per-user playlist and per-playlist entry limits", async () => {
    const [account] = await coreDatabase.db
      .insert(users)
      .values({})
      .returning();
    const ownerId = account!.id;

    await coreDatabase.db.insert(playlists).values(
      Array.from({ length: MAX_PLAYLISTS_PER_USER }, (_, index) => ({
        userId: ownerId,
        name: `Filler ${index}`,
        normalizedName: `filler ${index}`,
      })),
    );
    await expect(
      createPlaylist(coreDatabase.db, scanDatabase.db, {
        userId: ownerId,
        name: "One too many",
      }),
    ).rejects.toMatchObject({ code: "playlist_limit" });
    // Converging on an existing name is still allowed at the limit.
    await expect(
      createPlaylist(coreDatabase.db, scanDatabase.db, {
        userId: ownerId,
        name: "filler 0",
      }),
    ).resolves.toMatchObject({ created: false });

    const [playlist] = await coreDatabase.db
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
    const [album] = await coreDatabase.db
      .insert(albums)
      .values({
        artist: "Limit Test",
        title: `Limit ${ownerId}`,
        normalizedArtist: "limit test",
        normalizedTitle: `limit ${ownerId}`,
      })
      .returning();
    const seededReleases = await coreDatabase.db
      .insert(releases)
      .values(
        Array.from({ length: MAX_PLAYLIST_ENTRIES }, () => ({
          albumId: album!.id,
          identityKey: randomUUID().replaceAll("-", "").padEnd(64, "0"),
        })),
      )
      .returning({ id: releases.id });
    const seededItems = await coreDatabase.db
      .insert(libraryItems)
      .values(
        seededReleases.map((release) => ({
          userId: ownerId,
          releaseId: release.id,
          list: "wishlist" as const,
        })),
      )
      .returning({ id: libraryItems.id });
    await coreDatabase.db.insert(playlistEntries).values(
      seededItems.slice(0, MAX_PLAYLIST_ENTRIES - 1).map((item, index) => ({
        playlistId: playlist!.id,
        userId: ownerId,
        libraryItemId: item.id,
        position: index + 1,
      })),
    );

    const last = seededItems[MAX_PLAYLIST_ENTRIES - 1]!.id;
    const full = await addPlaylistEntry(coreDatabase.db, scanDatabase.db, {
      userId: ownerId,
      playlistId: playlist!.id,
      libraryItemId: last,
    });
    expect(full.created).toBe(true);
    expect(full.playlist.entries).toHaveLength(MAX_PLAYLIST_ENTRIES);

    const extra = await saveRecord("wishlist", ownerId);
    await expect(
      addPlaylistEntry(coreDatabase.db, scanDatabase.db, {
        userId: ownerId,
        playlistId: playlist!.id,
        libraryItemId: extra,
      }),
    ).rejects.toMatchObject({ code: "playlist_entry_limit" });
    // Re-adding a record already present converges even when full.
    await expect(
      addPlaylistEntry(coreDatabase.db, scanDatabase.db, {
        userId: ownerId,
        playlistId: playlist!.id,
        libraryItemId: last,
      }),
    ).resolves.toMatchObject({ created: false });

    await deleteTestAccount(ownerId);
    await coreDatabase.db.delete(albums).where(eq(albums.id, album!.id));
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
    const { record } = await placeLibraryRelease(coreDatabase.db, {
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
        ? await listFavoriteLibraryItemsForUser(
            coreDatabase.db,
            scanDatabase.db,
            {
              userId: ownerId,
              query: input.query,
              sort: input.sort,
              cursor,
              limit: input.limit,
            },
          )
        : await listLibraryItemsForUser(coreDatabase.db, scanDatabase.db, {
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
    const [account] = await coreDatabase.db
      .insert(users)
      .values({})
      .returning();
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
    const found = await listLibraryItemsForUser(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId: ownerId,
        list: "wishlist",
        query: "pagination RECORD 110",
      },
    );
    expect(found.items.map((item) => item.id)).toEqual([target.id]);
    expect(found.nextCursor).toBeNull();

    // LIKE wildcards in the query are literal characters, not patterns.
    const wildcard = await listLibraryItemsForUser(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId: ownerId,
        list: "wishlist",
        query: "Pagination Record 1__",
      },
    );
    expect(wildcard.items).toEqual([]);
    const percent = await listLibraryItemsForUser(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId: ownerId,
        list: "wishlist",
        query: "%",
      },
    );
    expect(percent.items).toEqual([]);
  });

  it("matches and orders by the confirmed artist and title, not the album row", async () => {
    // A scan confirmation carries corrected values that differ from the
    // shared album row the release was resolved to; search and sort must
    // follow what the user confirmed and sees (ADR-0012).
    const [scan] = await scanDatabase.db
      .insert(scans)
      .values({
        userId: ownerId,
        source: "single_upload",
        status: "identified",
        idempotencyKey: `pagination-confirm-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    await scanDatabase.db.insert(scanAttempts).values({
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
    const [release] = await coreDatabase.db
      .select({ albumId: releases.albumId })
      .from(releases)
      .where(eq(releases.id, confirmed.record.release!.id));
    await coreDatabase.db
      .update(albums)
      .set({ artist: "Zzz Album Row Artist", title: "Album Row Title" })
      .where(eq(albums.id, release!.albumId));

    const byConfirmed = await listLibraryItemsForUser(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId: ownerId,
        list: "wishlist",
        query: "aardvark corrected",
      },
    );
    expect(byConfirmed.items.map((item) => item.id)).toEqual([itemId]);
    expect(byConfirmed.items[0]!.release.artist).toBe(
      "Aardvark Corrected Artist",
    );
    const byAlbumRow = await listLibraryItemsForUser(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId: ownerId,
        list: "wishlist",
        query: "album row",
      },
    );
    expect(byAlbumRow.items).toEqual([]);

    // Sorted by artist the corrected name comes first of everything; sorted
    // by title it comes last — the album row's values place it nowhere near.
    const byArtist = await walk({ sort: "artist", limit: 100 });
    expect(byArtist.ids[0]).toBe(itemId);
    const byTitle = await walk({ sort: "title", limit: 100 });
    expect(byTitle.ids[byTitle.ids.length - 1]).toBe(itemId);

    await deleteLibraryItem(coreDatabase.db, scanDatabase.db, {
      userId: ownerId,
      itemId,
    });
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
    const firstPage = await listLibraryItemsForUser(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId: ownerId,
        list: "wishlist",
        sort: "recent",
        limit: 10,
      },
    );
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
    await updateLibraryItem(coreDatabase.db, scanDatabase.db, {
      userId: ownerId,
      itemId: edited,
      update: { notes: "edited mid-walk" },
    });

    const rest: string[] = [];
    let cursor = firstPage.nextCursor ?? undefined;
    while (cursor) {
      const page = await listLibraryItemsForUser(
        coreDatabase.db,
        scanDatabase.db,
        {
          userId: ownerId,
          list: "wishlist",
          sort: "recent",
          cursor,
          limit: 10,
        },
      );
      rest.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    }
    expect(rest).not.toContain(added);
    expect(rest).not.toContain(edited);
    for (const id of rest) expect(seen.has(id), id).toBe(false);
    expect(seen.size + rest.length).toBe(SEED_COUNT);

    await deleteLibraryItem(coreDatabase.db, scanDatabase.db, {
      userId: ownerId,
      itemId: added,
    });
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
      await updateLibraryItem(coreDatabase.db, scanDatabase.db, {
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
    for await (const page of iterateLibraryItemsForUser(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId: ownerId,
        list: "wishlist",
        sort: "artist",
        pageSize: 100,
      },
    )) {
      pages.push(page.length);
      ids.push(...page.map((item) => item.id));
    }
    expect(pages).toEqual([100, SEED_COUNT - 100]);
    expect(new Set(ids).size).toBe(SEED_COUNT);

    const none: unknown[] = [];
    for await (const page of iterateLibraryItemsForUser(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId: ownerId,
        list: "collection",
      },
    )) {
      none.push(page);
    }
    expect(none).toEqual([]);
  });

  it("rejects a cursor it cannot read or that belongs to another sort", async () => {
    const page = await listLibraryItemsForUser(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId: ownerId,
        list: "wishlist",
        sort: "artist",
        limit: 5,
      },
    );
    await expect(
      listLibraryItemsForUser(coreDatabase.db, scanDatabase.db, {
        userId: ownerId,
        list: "wishlist",
        sort: "title",
        cursor: page.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(
      listLibraryItemsForUser(coreDatabase.db, scanDatabase.db, {
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
    await deleteLibraryItem(coreDatabase.db, scanDatabase.db, {
      userId,
      itemId: other,
    });
  });

  function compare(a: string, b: string) {
    const left = a.toLowerCase();
    const right = b.toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  }
});

describe("account export and deletion", () => {
  async function createAccountWithData() {
    const [account] = await coreDatabase.db
      .insert(users)
      .values({})
      .returning();
    const accountId = account!.id;

    const [scan] = await scanDatabase.db
      .insert(scans)
      .values({
        userId: accountId,
        source: "single_upload",
        status: "identified",
        idempotencyKey: `account-export-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    await scanDatabase.db.insert(imageAssets).values({
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
    await scanDatabase.db.insert(scanAttempts).values({
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
    await updateLibraryItem(coreDatabase.db, scanDatabase.db, {
      userId: accountId,
      itemId: confirmation.record.libraryItem!.id,
      update: { favorite: true },
    });
    const { playlist } = await createPlaylist(
      coreDatabase.db,
      scanDatabase.db,
      {
        userId: accountId,
        name: "Export me",
      },
    );
    await addPlaylistEntry(coreDatabase.db, scanDatabase.db, {
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

    const exported = await getAccountExportForUser(
      scanDatabase.db,
      coreDatabase.db,
      {
        userId: accountId,
      },
    );

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

    await deleteAccount(scanDatabase.db, coreDatabase.db, {
      userId: accountId,
    });
  });

  it("rejects exporting an account that does not exist", async () => {
    await expect(
      getAccountExportForUser(scanDatabase.db, coreDatabase.db, {
        userId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("deletes an account with confirmation history despite the restrict FKs, without touching shared catalog rows", async () => {
    const { accountId, scanId, playlistId } = await createAccountWithData();
    const [libraryItemBeforeDelete] = await coreDatabase.db
      .select({ releaseId: libraryItems.releaseId })
      .from(libraryItems)
      .where(eq(libraryItems.userId, accountId));
    const releaseId = libraryItemBeforeDelete!.releaseId;

    const deleted = await deleteAccount(scanDatabase.db, coreDatabase.db, {
      userId: accountId,
    });

    expect(deleted.id).toBe(accountId);
    expect(deleted.objectKeys.length).toBeGreaterThan(0);
    expect(
      await coreDatabase.db.select().from(users).where(eq(users.id, accountId)),
    ).toHaveLength(0);
    expect(
      await scanDatabase.db.select().from(scans).where(eq(scans.id, scanId)),
    ).toHaveLength(0);
    expect(
      await scanDatabase.db
        .select()
        .from(scanConfirmations)
        .where(eq(scanConfirmations.scanId, scanId)),
    ).toHaveLength(0);
    expect(
      await coreDatabase.db
        .select()
        .from(libraryItems)
        .where(eq(libraryItems.userId, accountId)),
    ).toHaveLength(0);
    expect(
      await coreDatabase.db
        .select()
        .from(playlists)
        .where(eq(playlists.id, playlistId)),
    ).toHaveLength(0);
    expect(
      await coreDatabase.db
        .select()
        .from(playlistEntries)
        .where(eq(playlistEntries.playlistId, playlistId)),
    ).toHaveLength(0);
    // The shared release/album rows must survive the account's deletion.
    expect(
      await coreDatabase.db
        .select()
        .from(releases)
        .where(eq(releases.id, releaseId)),
    ).toHaveLength(1);
  });

  it("rejects deleting an account that does not exist", async () => {
    await expect(
      deleteAccount(scanDatabase.db, coreDatabase.db, { userId: randomUUID() }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("P4.2 Task 3: async scan-confirmation pipeline (ADR-0028)", () => {
  async function insertReviewableScan() {
    const [scan] = await scanDatabase.db
      .insert(scans)
      .values({
        userId,
        source: "single_upload",
        status: "identified",
        idempotencyKey: `pipeline-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    await scanDatabase.db.insert(scanAttempts).values({
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
    const [row] = await scanDatabase.db
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
        coreDatabase.db,
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

    const result = await confirmScan(scanDatabase.db, coreDatabase.db, input);

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

    const [storedConfirmation] = await scanDatabase.db
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
      await coreDatabase.db
        .select()
        .from(libraryItems)
        .where(eq(libraryItems.confirmedFromScanId, scanId)),
    ).toHaveLength(0);
  });

  it("replays a pending confirmation idempotently and still conflicts on a different payload, never treating it as removed", async () => {
    const scanId = await insertReviewableScan();
    const input = collectionConfirmationInput(scanId);

    const first = await confirmScan(scanDatabase.db, coreDatabase.db, input);
    const replay = await confirmScan(scanDatabase.db, coreDatabase.db, input);

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.record).toEqual(first.record);

    await expect(
      confirmScan(scanDatabase.db, coreDatabase.db, {
        ...input,
        confirmation: { ...input.confirmation, title: "A different title" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    // A conflict must not have deleted-and-reset the pending row (the
    // ADR-0018 "removed" branch, which a pending confirmation's null
    // libraryItemId could otherwise be mistaken for).
    const [stillPending] = await scanDatabase.db
      .select()
      .from(scanConfirmations)
      .where(eq(scanConfirmations.scanId, scanId));
    expect(stillPending).toMatchObject({ status: "pending" });
  });

  it("processScanConfirmation resolves the release and writes the library row exactly once, even if the event is delivered twice", async () => {
    const scanId = await insertReviewableScan();
    const input = collectionConfirmationInput(scanId);
    await confirmScan(scanDatabase.db, coreDatabase.db, input);
    const { event, eventKey } = await readOutboxEvent(
      scanId,
      input.idempotencyKey,
    );

    await processScanConfirmation(coreDatabase.db, event);
    await processScanConfirmation(coreDatabase.db, event);

    const receipts = await coreDatabase.db
      .select()
      .from(confirmationReceipts)
      .where(eq(confirmationReceipts.idempotencyKey, eventKey));
    expect(receipts).toHaveLength(1);

    const libraryRows = await coreDatabase.db
      .select()
      .from(libraryItems)
      .where(eq(libraryItems.confirmedFromScanId, scanId));
    expect(libraryRows).toHaveLength(1);
    const copyRows = await coreDatabase.db
      .select()
      .from(libraryCopies)
      .where(eq(libraryCopies.confirmedFromScanId, scanId));
    expect(copyRows).toHaveLength(1);
  });

  it("applyConfirmationCompletion projects the completion and is idempotent against redelivery or a missing row", async () => {
    const scanId = await insertReviewableScan();
    const input = collectionConfirmationInput(scanId);
    await confirmScan(scanDatabase.db, coreDatabase.db, input);
    const { event, eventKey } = await readOutboxEvent(
      scanId,
      input.idempotencyKey,
    );
    await processScanConfirmation(coreDatabase.db, event);
    const [receipt] = await coreDatabase.db
      .select()
      .from(confirmationReceipts)
      .where(eq(confirmationReceipts.idempotencyKey, eventKey));
    const completion =
      CONFIRMATION_COMPLETED_EVENT_CONTRACT.consumerSchema.parse(
        receipt!.payload,
      );

    const applied = await applyConfirmationCompletion(
      scanDatabase.db,
      completion,
    );
    // P4.2 Task 5 (ADR-0028): the confirmation-to-library latency this
    // task's target bounds -- non-negative, since completedAt is always at
    // or after confirmScan's own confirmedAt write.
    expect(applied?.latencyMs).toBeGreaterThanOrEqual(0);
    const [afterFirst] = await scanDatabase.db
      .select()
      .from(scanConfirmations)
      .where(eq(scanConfirmations.scanId, scanId));
    expect(afterFirst).toMatchObject({
      status: "completed",
      releaseId: completion.releaseId,
      libraryItemId: completion.libraryItemId,
      copyId: completion.copyId,
    });

    // Redelivery after completion is a silent no-op, not a re-application,
    // and reports no latency to measure.
    await expect(
      applyConfirmationCompletion(scanDatabase.db, completion),
    ).resolves.toBeNull();
    const [afterRedelivery] = await scanDatabase.db
      .select()
      .from(scanConfirmations)
      .where(eq(scanConfirmations.scanId, scanId));
    expect(afterRedelivery).toEqual(afterFirst);

    // A completion event naming a scan/idempotencyKey with no matching row
    // is a defensive no-op, not a throw -- this handler runs from a queue
    // consumer with no request to fail back to.
    await expect(
      applyConfirmationCompletion(scanDatabase.db, {
        ...completion,
        scanId: randomUUID(),
        idempotencyKey: `orphan-${randomUUID()}`,
      }),
    ).resolves.toBeNull();
  });

  it("dispatchNextConfirmationReceipt claims, backs off on a failed publish, and marks published on success", async () => {
    const scanId = await insertReviewableScan();
    const input = collectionConfirmationInput(scanId);
    await confirmScan(scanDatabase.db, coreDatabase.db, input);
    const { event, eventKey } = await readOutboxEvent(
      scanId,
      input.idempotencyKey,
    );
    await processScanConfirmation(coreDatabase.db, event);

    const firstDispatchAt = new Date(Date.now() + 1_000);
    await dispatchConfirmationReceiptUntil(
      eventKey,
      async () => {
        throw new Error("synthetic delivery failure");
      },
      firstDispatchAt,
    );
    const [afterDeferral] = await coreDatabase.db
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

    const [receipt] = await coreDatabase.db
      .select()
      .from(confirmationReceipts)
      .where(eq(confirmationReceipts.idempotencyKey, eventKey));
    expect(receipt?.publishedAt).toBeInstanceOf(Date);
  });

  it("runs the full pipeline end to end without a queue, from a pending confirmation to a completed projection", async () => {
    const scanId = await insertReviewableScan();
    const input = collectionConfirmationInput(scanId);

    const pending = await confirmScan(scanDatabase.db, coreDatabase.db, input);
    expect(pending.record.status).toBe("pending");

    const { event, eventKey } = await readOutboxEvent(
      scanId,
      input.idempotencyKey,
    );
    await processScanConfirmation(coreDatabase.db, event);
    const dispatched = await dispatchConfirmationReceiptUntil(
      eventKey,
      async (payload) => {
        await applyConfirmationCompletion(
          scanDatabase.db,
          payload as Parameters<typeof applyConfirmationCompletion>[1],
        );
      },
    );
    expect(dispatched.status).toBe("published");

    await expect(
      getScanForUser(scanDatabase.db, coreDatabase.db, { userId, scanId }),
    ).resolves.toMatchObject({
      confirmation: {
        status: "completed",
        release: { artist: input.confirmation.artist },
        libraryItem: { list: "collection" },
      },
    });
  });

  it("exports a pending confirmation with a null releaseId and pending status", async () => {
    const [account] = await coreDatabase.db
      .insert(users)
      .values({})
      .returning();
    const accountId = account!.id;
    const [scan] = await scanDatabase.db
      .insert(scans)
      .values({
        userId: accountId,
        source: "single_upload",
        status: "identified",
        idempotencyKey: `pipeline-export-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    await scanDatabase.db.insert(scanAttempts).values({
      scanId: scan!.id,
      attemptNumber: 1,
      status: "succeeded",
      model: "integration-test-model",
      promptVersion: "integration-test.v1",
      providerResponseId: `response-${randomUUID()}`,
      durationMs: 20,
      completedAt: new Date(),
    });
    await confirmScan(scanDatabase.db, coreDatabase.db, {
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

    const exported = await getAccountExportForUser(
      scanDatabase.db,
      coreDatabase.db,
      {
        userId: accountId,
      },
    );
    expect(exported.confirmations).toEqual([
      expect.objectContaining({
        scanId: scan!.id,
        libraryItemId: null,
        releaseId: null,
        status: "pending",
        list: null,
      }),
    ]);

    // Torn down directly rather than through `deleteAccount`: this account's
    // confirmation is deliberately still `pending`, which is exactly the case
    // `deleteAccount` defers (it marks the account and deletes nothing), so
    // using it here would leak this user and its pending confirmation into
    // every later run -- and `listStalePendingConfirmations` below queries
    // the whole table, not one user's rows.
    await deleteTestAccount(accountId);
  });

  it("reconcileScanConfirmation completes a confirmation stuck before hop 2 (no receipt yet)", async () => {
    const scanId = await insertReviewableScan();
    const input = collectionConfirmationInput(scanId);
    await confirmScan(scanDatabase.db, coreDatabase.db, input);

    const result = await reconcileScanConfirmation(
      scanDatabase.db,
      coreDatabase.db,
      {
        userId,
        scanId,
      },
    );

    expect(result).toMatchObject({
      status: "completed",
      release: { artist: input.confirmation.artist },
      libraryItem: { list: "collection" },
    });
    const { eventKey } = await readOutboxEvent(scanId, input.idempotencyKey);
    const receipts = await coreDatabase.db
      .select()
      .from(confirmationReceipts)
      .where(eq(confirmationReceipts.idempotencyKey, eventKey));
    expect(receipts).toHaveLength(1);
    const libraryRows = await coreDatabase.db
      .select()
      .from(libraryItems)
      .where(eq(libraryItems.confirmedFromScanId, scanId));
    expect(libraryRows).toHaveLength(1);
    const copyRows = await coreDatabase.db
      .select()
      .from(libraryCopies)
      .where(eq(libraryCopies.confirmedFromScanId, scanId));
    expect(copyRows).toHaveLength(1);
  });

  it("reconcileScanConfirmation completes a confirmation stuck after hop 2 (receipt exists, unpublished)", async () => {
    const scanId = await insertReviewableScan();
    const input = collectionConfirmationInput(scanId);
    await confirmScan(scanDatabase.db, coreDatabase.db, input);
    const { event, eventKey } = await readOutboxEvent(
      scanId,
      input.idempotencyKey,
    );
    // Hop 2 already ran (e.g. the queue delivered the event once), but the
    // completion receipt was never published -- exactly the state a
    // dead-lettered `confirmation.completed.v1` delivery would leave behind.
    await processScanConfirmation(coreDatabase.db, event);

    const result = await reconcileScanConfirmation(
      scanDatabase.db,
      coreDatabase.db,
      {
        userId,
        scanId,
      },
    );

    expect(result).toMatchObject({ status: "completed" });
    const receipts = await coreDatabase.db
      .select()
      .from(confirmationReceipts)
      .where(eq(confirmationReceipts.idempotencyKey, eventKey));
    expect(receipts).toHaveLength(1);
    const libraryRows = await coreDatabase.db
      .select()
      .from(libraryItems)
      .where(eq(libraryItems.confirmedFromScanId, scanId));
    expect(libraryRows).toHaveLength(1);
  });

  it("reconcileScanConfirmation on an already-completed confirmation is a safe no-op", async () => {
    const scanId = await insertReviewableScan();
    const input = collectionConfirmationInput(scanId);
    await confirmScan(scanDatabase.db, coreDatabase.db, input);
    const { event, eventKey } = await readOutboxEvent(
      scanId,
      input.idempotencyKey,
    );
    await processScanConfirmation(coreDatabase.db, event);
    await dispatchConfirmationReceiptUntil(eventKey, async (payload) => {
      await applyConfirmationCompletion(
        scanDatabase.db,
        payload as Parameters<typeof applyConfirmationCompletion>[1],
      );
    });

    const before = await getScanConfirmationForUser(
      scanDatabase.db,
      coreDatabase.db,
      {
        userId,
        scanId,
      },
    );
    const result = await reconcileScanConfirmation(
      scanDatabase.db,
      coreDatabase.db,
      {
        userId,
        scanId,
      },
    );

    expect(result).toEqual(before);
    const libraryRows = await coreDatabase.db
      .select()
      .from(libraryItems)
      .where(eq(libraryItems.confirmedFromScanId, scanId));
    expect(libraryRows).toHaveLength(1);
  });

  it("processScanConfirmation is safe under two concurrent callers for the same event", async () => {
    // Simulates the race P4.2 Task 4 introduced: reconciliation and the
    // normal queue consumer both calling processScanConfirmation for the
    // same event at the same time, both missing the not-yet-inserted
    // receipt. Without the advisory lock this added, one caller would hit a
    // raw 23505 on the receipt insert instead of the two converging safely.
    const scanId = await insertReviewableScan();
    const input = collectionConfirmationInput(scanId);
    await confirmScan(scanDatabase.db, coreDatabase.db, input);
    const { event, eventKey } = await readOutboxEvent(
      scanId,
      input.idempotencyKey,
    );

    await Promise.all([
      processScanConfirmation(coreDatabase.db, event),
      processScanConfirmation(coreDatabase.db, event),
    ]);

    const receipts = await coreDatabase.db
      .select()
      .from(confirmationReceipts)
      .where(eq(confirmationReceipts.idempotencyKey, eventKey));
    expect(receipts).toHaveLength(1);
    const libraryRows = await coreDatabase.db
      .select()
      .from(libraryItems)
      .where(eq(libraryItems.confirmedFromScanId, scanId));
    expect(libraryRows).toHaveLength(1);
    const copyRows = await coreDatabase.db
      .select()
      .from(libraryCopies)
      .where(eq(libraryCopies.confirmedFromScanId, scanId));
    expect(copyRows).toHaveLength(1);
  });

  it("listStalePendingConfirmations respects olderThan/limit and ignores completed rows", async () => {
    async function insertBackdatedPendingConfirmation(confirmedAt: Date) {
      const scanId = await insertReviewableScan();
      await confirmScan(
        scanDatabase.db,
        coreDatabase.db,
        collectionConfirmationInput(scanId),
      );
      await scanDatabase.db
        .update(scanConfirmations)
        .set({ confirmedAt })
        .where(eq(scanConfirmations.scanId, scanId));
      return scanId;
    }

    const olderStaleScanId = await insertBackdatedPendingConfirmation(
      new Date(Date.now() - 10 * 60_000),
    );
    const newerStaleScanId = await insertBackdatedPendingConfirmation(
      new Date(Date.now() - 8 * 60_000),
    );

    const freshScanId = await insertReviewableScan();
    await confirmScan(
      scanDatabase.db,
      coreDatabase.db,
      collectionConfirmationInput(freshScanId),
    );

    const completedScanId = await insertReviewableScan();
    const completedInput = collectionConfirmationInput(completedScanId);
    await confirmScan(scanDatabase.db, coreDatabase.db, completedInput);
    const { event: completedEvent, eventKey: completedKey } =
      await readOutboxEvent(completedScanId, completedInput.idempotencyKey);
    await processScanConfirmation(coreDatabase.db, completedEvent);
    await dispatchConfirmationReceiptUntil(completedKey, async (payload) => {
      await applyConfirmationCompletion(
        scanDatabase.db,
        payload as Parameters<typeof applyConfirmationCompletion>[1],
      );
    });

    const olderThan = new Date(Date.now() - 5 * 60_000);

    const limited = await listStalePendingConfirmations(scanDatabase.db, {
      olderThan,
      limit: 1,
    });
    expect(limited).toEqual([
      expect.objectContaining({ scanId: olderStaleScanId }),
    ]);

    const all = await listStalePendingConfirmations(scanDatabase.db, {
      olderThan,
      limit: 10,
    });
    const staleIds = all.map((row) => row.scanId);
    expect(staleIds).toContain(olderStaleScanId);
    expect(staleIds).toContain(newerStaleScanId);
    expect(staleIds).not.toContain(freshScanId);
    expect(staleIds).not.toContain(completedScanId);
  });

  it("isolates outbox dispatch by topic: a registry scoped to one topic never claims or backs off a pending row of the other, even when the other is older (P4.2 Task 5)", async () => {
    // A real, older scan.analyze.v1 row -- the same setup
    // "cancels a queued scan and skips its outbox dispatch" above uses to get
    // one, so the row parses against the real registered contract.
    const scan = await createOrGetScan(scanDatabase.db, {
      userId,
      source: "single_upload",
      idempotencyKey: `isolation-scan-${randomUUID()}`,
    });
    const upload = await createOrGetImageUpload(scanDatabase.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey: `isolation-upload-${randomUUID()}`,
      filename: "front.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 512,
      checksumSha256: "f".repeat(64),
      maxImages: 12,
    });
    await completeImageUpload(scanDatabase.db, {
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
    const submitted = await submitScan(scanDatabase.db, {
      userId,
      scanId: scan.record.id,
      idempotencyKey: `isolation-submit-${randomUUID()}`,
    });

    // A real, newer scan.confirmed.v1 row, created after the analysis row
    // above so it is unambiguously the newer of the two.
    const confirmedScanId = await insertReviewableScan();
    const confirmationInput = collectionConfirmationInput(confirmedScanId);
    await confirmScan(scanDatabase.db, coreDatabase.db, confirmationInput);
    const { eventKey: confirmedIdempotencyKey } = await readOutboxEvent(
      confirmedScanId,
      confirmationInput.idempotencyKey,
    );

    // Unlike scan.analyze.v1 rows (routinely drained by dispatchUntil
    // elsewhere in this file), most of this describe block's scan.confirmed.v1
    // rows are consumed directly via readOutboxEvent, never through a real
    // dispatch call, and stay sitting in outbox_messages undelivered for the
    // rest of the suite -- a fixed small attempt budget is not enough to
    // drain that backlog ahead of this test's own row. Count exactly how many
    // are currently pending instead: FIFO ordering guarantees this test's row
    // is claimed at or before that count, however large the backlog is.
    const pendingConfirmedEvents = await scanDatabase.db
      .select({ idempotencyKey: outboxMessages.idempotencyKey })
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.topic, SCAN_CONFIRMED_EVENT),
          isNull(outboxMessages.publishedAt),
        ),
      );
    expect(
      pendingConfirmedEvents.some(
        (row) => row.idempotencyKey === confirmedIdempotencyKey,
      ),
    ).toBe(true);

    // A confirmed-event-only dispatcher (apps/worker's own
    // dispatchAvailableConfirmedEvents shape) reaches the newer row directly.
    const publishedIdempotencyKeys = new Set<string>();
    const attemptBudget = pendingConfirmedEvents.length + 5;
    for (let attempts = 0; attempts < attemptBudget; attempts += 1) {
      if (publishedIdempotencyKeys.has(confirmedIdempotencyKey)) break;
      const result = await dispatchNextOutboxMessage(
        scanDatabase.db,
        {
          [SCAN_CONFIRMED_EVENT]: async (_payload, idempotencyKey) => {
            publishedIdempotencyKeys.add(idempotencyKey);
          },
        },
        new Date(Date.now() + 1_000),
      );
      if (result.status === "idle") break;
    }
    expect(publishedIdempotencyKeys.has(confirmedIdempotencyKey)).toBe(true);

    // The older analysis row was never claimed by the confirmed-only
    // dispatcher above: not published, not backed off, not even attempted.
    // Before Task 5's topic-scoped query, this exact scenario would instead
    // have claimed the analysis row first (it is the older of the two),
    // found no publisher for it in a confirmed-only registry, and backed it
    // off under the "no publisher registered" error path -- real cross-topic
    // interference, not merely a missed optimization, and exactly the
    // starvation the roadmap names in the other direction (a deep analysis
    // backlog delaying a newer confirmation).
    const [analysisRow] = await scanDatabase.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.idempotencyKey, submitted.jobId));
    expect(analysisRow).toMatchObject({
      publishedAt: null,
      publishAttempts: 0,
      lastError: null,
    });

    // Symmetrically, an analysis-only dispatcher now reaches that row
    // without needing the already-published confirmed-event row out of the
    // way -- the two queries are fully independent in both directions.
    const dispatchedAnalysis = await dispatchUntil(
      submitted.jobId,
      async () => {},
    );
    expect(dispatchedAnalysis.jobId).toBe(submitted.jobId);
  });
});

describe("P4.2 Task 6: durable account deletion and release_id FK policy (new ADR)", () => {
  async function createAccount() {
    const [account] = await coreDatabase.db
      .insert(users)
      .values({})
      .returning();
    return account!.id;
  }

  async function insertReviewableScanForAccount(accountId: string) {
    const [scan] = await scanDatabase.db
      .insert(scans)
      .values({
        userId: accountId,
        source: "single_upload",
        status: "identified",
        idempotencyKey: `task6-scan-${randomUUID()}`,
        completedAt: new Date(),
      })
      .returning();
    await scanDatabase.db.insert(scanAttempts).values({
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

  function collectionConfirmationInput(accountId: string, scanId: string) {
    return {
      userId: accountId,
      scanId,
      idempotencyKey: `task6-confirm-${randomUUID()}`,
      confirmation: {
        selectedCandidateId: null,
        artist: `Task 6 Test ${randomUUID()}`,
        title: "Durable Deletion",
        releaseYear: 2002,
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
        copy: null,
      },
    };
  }

  async function driveToCompletion(scanId: string, idempotencyKey: string) {
    const eventKey = confirmationEventId(scanId, idempotencyKey);
    const [outboxRow] = await scanDatabase.db
      .select()
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.topic, SCAN_CONFIRMED_EVENT),
          eq(outboxMessages.idempotencyKey, eventKey),
        ),
      )
      .limit(1);
    const confirmedEvent = SCAN_CONFIRMED_EVENT_CONTRACT.consumerSchema.parse(
      outboxRow!.payload,
    );
    await processScanConfirmation(coreDatabase.db, confirmedEvent);

    const [receipt] = await coreDatabase.db
      .select()
      .from(confirmationReceipts)
      .where(eq(confirmationReceipts.idempotencyKey, eventKey))
      .limit(1);
    const completedEvent =
      CONFIRMATION_COMPLETED_EVENT_CONTRACT.consumerSchema.parse(
        receipt!.payload,
      );
    await applyConfirmationCompletion(scanDatabase.db, completedEvent);
  }

  it("defers a whole-account delete while a confirmation is still pending, instead of racing hop 2 into a foreign-key violation", async () => {
    const accountId = await createAccount();
    const scanId = await insertReviewableScanForAccount(accountId);
    const confirmInput = collectionConfirmationInput(accountId, scanId);
    const pendingConfirmation = await confirmScan(
      scanDatabase.db,
      coreDatabase.db,
      confirmInput,
    );
    expect(pendingConfirmation.record.status).toBe("pending");

    const deletion = await deleteAccount(scanDatabase.db, coreDatabase.db, {
      userId: accountId,
    });
    expect(deletion).toMatchObject({
      id: accountId,
      status: "pending",
      objectKeys: [],
    });

    // The account is durably marked for deletion, but not yet gone: hop 2
    // can still process the already-dispatched event against a users row
    // that still exists -- exactly the race ADR-0028 documented and left
    // open for this task, now closed by deferring instead of racing.
    expect(
      await coreDatabase.db.select().from(users).where(eq(users.id, accountId)),
    ).toHaveLength(1);

    await expect(
      driveToCompletion(scanId, confirmInput.idempotencyKey),
    ).resolves.toBeUndefined();

    // Nothing is pending anymore, so a retried delete finalizes immediately.
    const finalDeletion = await deleteAccount(
      scanDatabase.db,
      coreDatabase.db,
      {
        userId: accountId,
      },
    );
    expect(finalDeletion.status).toBe("deleted");
    expect(
      await coreDatabase.db.select().from(users).where(eq(users.id, accountId)),
    ).toHaveLength(0);
  });

  it("refuses a new confirmation once deletion has been requested, even while an earlier confirmation still drains", async () => {
    const accountId = await createAccount();
    const drainingScanId = await insertReviewableScanForAccount(accountId);
    const newScanId = await insertReviewableScanForAccount(accountId);

    await confirmScan(
      scanDatabase.db,
      coreDatabase.db,
      collectionConfirmationInput(accountId, drainingScanId),
    );
    const deletion = await deleteAccount(scanDatabase.db, coreDatabase.db, {
      userId: accountId,
    });
    expect(deletion.status).toBe("pending");

    await expect(
      confirmScan(
        scanDatabase.db,
        coreDatabase.db,
        collectionConfirmationInput(accountId, newScanId),
      ),
    ).rejects.toMatchObject({ code: "account_deleting" });

    // Cleanup: bypass the app-level guard directly, since this account's own
    // deletion workflow is deliberately left mid-drain by this test.
    await deleteTestAccount(accountId);
  });

  it("finalizes a drained deletion through the background sweep helpers", async () => {
    const accountId = await createAccount();
    const scanId = await insertReviewableScanForAccount(accountId);
    const confirmInput = collectionConfirmationInput(accountId, scanId);
    await confirmScan(scanDatabase.db, coreDatabase.db, confirmInput);

    const deletion = await deleteAccount(scanDatabase.db, coreDatabase.db, {
      userId: accountId,
    });
    expect(deletion.status).toBe("pending");

    // P4.2 Task 7 (ADR-0030): the candidate list names every account whose
    // deletion was requested, ready or not -- readiness moved inside
    // finalizeAccountDeletion, which re-checks it under its own lock and
    // returns null while a confirmation is still pending.
    expect(
      await listAccountsPendingDeletion(coreDatabase.db, { limit: 500 }),
    ).toContain(accountId);
    expect(
      await finalizeAccountDeletion(scanDatabase.db, coreDatabase.db, {
        userId: accountId,
      }),
    ).toBeNull();

    await driveToCompletion(scanId, confirmInput.idempotencyKey);

    expect(
      await listAccountsPendingDeletion(coreDatabase.db, { limit: 500 }),
    ).toContain(accountId);
    const finalized = await finalizeAccountDeletion(
      scanDatabase.db,
      coreDatabase.db,
      {
        userId: accountId,
      },
    );
    expect(finalized).toMatchObject({ id: accountId });

    // Idempotent: a racing second sweep pass (or a retried request) finds
    // the account already gone and no-ops rather than throwing.
    expect(
      await finalizeAccountDeletion(scanDatabase.db, coreDatabase.db, {
        userId: accountId,
      }),
    ).toBeNull();
  });

  it("still protects a completed confirmation's release reference, via the status-consistency check now that no cross-schema FK survives", async () => {
    const accountId = await createAccount();
    const scanId = await insertReviewableScanForAccount(accountId);
    const result = await confirmScanAndComplete(
      collectionConfirmationInput(accountId, scanId),
    );
    const releaseId = result.record.release!.id;

    // The surviving half of ADR-0029's protection, and the only half that
    // can survive the P4.2 Task 7 split: nothing may null a `completed`
    // confirmation's release_id, so its audit reference cannot be erased.
    await expect(
      scanDatabase.db
        .update(scanConfirmations)
        .set({ releaseId: null })
        .where(eq(scanConfirmations.scanId, scanId)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    // The half that is deliberately gone (P4.2 Task 7, ADR-0030): deleting
    // the release used to cascade a SET NULL into this completed row
    // through scan_confirmations_release_id_fkey and be rejected by the
    // check above. Migration 022 drops that FK -- no cross-schema
    // constraint can exist once scan and core are separate schemas/roles --
    // so the delete now succeeds and the confirmation keeps naming a
    // release row that is gone. The replacement guarantee is that nothing
    // in the application ever deletes a `releases` row (see schema.ts's
    // note on this column); reviewed_release stays the durable audit
    // projection of what was confirmed either way.
    await coreDatabase.db.delete(releases).where(eq(releases.id, releaseId));

    const [confirmationRow] = await scanDatabase.db
      .select()
      .from(scanConfirmations)
      .where(eq(scanConfirmations.scanId, scanId));
    expect(confirmationRow).toMatchObject({
      status: "completed",
      releaseId,
    });
    expect(confirmationRow!.reviewedRelease).toMatchObject({
      artist: result.record.release!.artist,
      title: result.record.release!.title,
    });

    await deleteAccount(scanDatabase.db, coreDatabase.db, {
      userId: accountId,
    });
  });

  it("nulls confirmation_receipts.release_id on release deletion instead of blocking it, preserving the audit payload", async () => {
    const accountId = await createAccount();
    const scanId = await insertReviewableScanForAccount(accountId);
    const result = await confirmScanAndComplete(
      collectionConfirmationInput(accountId, scanId),
    );
    const releaseId = result.record.release!.id;
    const libraryItemId = result.record.libraryItem!.id;

    // Clear every other row that still protects this release -- a synthetic
    // setup: in every real product flow, confirmation_receipts always
    // cascades with its owning user (it never outlives it), so this isolates
    // this table's own release_id FK behavior at the DB level rather than
    // simulating a reachable product flow.
    await scanDatabase.db
      .delete(scanConfirmations)
      .where(eq(scanConfirmations.scanId, scanId));
    await coreDatabase.db
      .delete(libraryCopies)
      .where(eq(libraryCopies.libraryItemId, libraryItemId));
    await coreDatabase.db
      .delete(libraryItems)
      .where(eq(libraryItems.id, libraryItemId));

    await coreDatabase.db.delete(releases).where(eq(releases.id, releaseId));

    const [receiptRow] = await coreDatabase.db
      .select()
      .from(confirmationReceipts)
      .where(eq(confirmationReceipts.scanId, scanId));
    expect(receiptRow!.releaseId).toBeNull();
    expect((receiptRow!.payload as { releaseId: string }).releaseId).toBe(
      releaseId,
    );

    await deleteTestAccount(accountId);
  });
});
