import {
  ALBUM_IDENTIFICATION_PROMPT_VERSION,
  createOpenAIAlbumIdentifier,
} from "@vinylhound/ai";
import { loadQueueWorkerConfig } from "@vinylhound/config";
import {
  ANALYZE_SCAN_JOB,
  SCAN_CONFIRMED_EVENT,
  type AnalyzeScanJob,
  type ConfirmationCompletedEvent,
  type ScanConfirmedEvent,
} from "@vinylhound/contracts";
import {
  cleanupAbandonedScans,
  coreDatabaseOptionsFromConfig,
  createCoreDatabase,
  createScanDatabase,
  dispatchNextConfirmationReceipt,
  dispatchNextOutboxMessage,
  finalizeAccountDeletion,
  listAccountsPendingDeletion,
  listStalePendingConfirmations,
  reconcileScanConfirmation,
  scanDatabaseOptionsFromConfig,
} from "@vinylhound/database";
import {
  createAnalyzeScanWorker,
  createBullMqScanQueue,
  createConfirmationCompletionQueue,
  createConfirmationCompletionWorker,
  createConfirmationProcessingQueue,
  createConfirmationProcessingWorker,
  createSqsAnalyzeScanWorker,
  createSqsConfirmationCompletionQueue,
  createSqsConfirmationCompletionWorker,
  createSqsConfirmationProcessingQueue,
  createSqsConfirmationProcessingWorker,
  createSqsScanQueue,
} from "@vinylhound/queue";
import { createS3ObjectStorage } from "@vinylhound/storage";
import { writeFile } from "node:fs/promises";

import { createScanAnalysisHandler } from "./analysis-handler.ts";
import { createConfirmationCompletionHandler } from "./confirmation-completion-handler.ts";
import { createConfirmationProcessingHandler } from "./confirmation-processing-handler.ts";
import { startQueueMetricsPublisher } from "./metrics.ts";
import { requireOpenAiApiKey } from "./require-openai-key.ts";

const shutdownSignals = ["SIGINT", "SIGTERM"] as const;
const config = loadQueueWorkerConfig();
requireOpenAiApiKey(config.OPENAI_API_KEY);
// P4.2 Task 7 (ADR-0030): two role-scoped connections, never one shared
// pool -- see the same note on apps/web/src/server/context.ts.
const scanDatabase = createScanDatabase(scanDatabaseOptionsFromConfig(config));
const coreDatabase = createCoreDatabase(coreDatabaseOptionsFromConfig(config));
const queue =
  config.QUEUE_DRIVER === "sqs"
    ? createSqsScanQueue({
        queueUrl: config.SQS_QUEUE_URL!,
        deadLetterQueueUrl: config.SQS_DEAD_LETTER_QUEUE_URL,
      })
    : createBullMqScanQueue({
        redisUrl: config.REDIS_URL!,
        queueName: config.SCAN_QUEUE_NAME,
      });
const metricsPublisher = startQueueMetricsPublisher(queue, config);
const storage = createS3ObjectStorage({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  bucket: config.S3_BUCKET,
  accessKeyId: config.S3_ACCESS_KEY_ID,
  secretAccessKey: config.S3_SECRET_ACCESS_KEY,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
});
const onAnalyzeScan = createScanAnalysisHandler({
  database: scanDatabase.db,
  storage,
  identifier: createOpenAIAlbumIdentifier({
    apiKey: config.OPENAI_API_KEY,
    model: config.OPENAI_VISION_MODEL,
    imageDetail: config.OPENAI_IMAGE_DETAIL,
    timeoutMs: config.OPENAI_TIMEOUT_MS,
  }),
  configuredModel: config.OPENAI_VISION_MODEL,
  promptVersion: ALBUM_IDENTIFICATION_PROMPT_VERSION,
});
const analysisWorker =
  config.QUEUE_DRIVER === "sqs"
    ? createSqsAnalyzeScanWorker({
        queueUrl: config.SQS_QUEUE_URL!,
        maxAttempts: config.SQS_MAX_RECEIVE_COUNT,
        visibilityTimeoutSeconds: config.SQS_VISIBILITY_TIMEOUT_SECONDS,
        onAnalyzeScan,
        onError: (error) => {
          console.error("[worker] SQS scan consumer error", {
            errorName: error.name,
          });
        },
      })
    : createAnalyzeScanWorker({
        redisUrl: config.REDIS_URL!,
        queueName: config.SCAN_QUEUE_NAME,
        concurrency: config.ANALYSIS_CONCURRENCY,
        onAnalyzeScan,
        onError: (error) => {
          console.error("[worker] BullMQ scan consumer error", {
            errorName: error.name,
          });
        },
      });

// P4.2 Task 3 (ADR-0028): both the "core" consumer (confirmation processing:
// resolves a release, writes library_items/library_copies) and the "scan"
// projector (confirmation completion: updates scan_confirmations) run in
// this same physical process today. The boundary this task draws is
// transactional -- which tables each handler's own transaction touches --
// not process isolation; a physical split is Task 7's job.
const confirmationProcessingQueue =
  config.QUEUE_DRIVER === "sqs"
    ? createSqsConfirmationProcessingQueue({
        queueUrl: config.SQS_CONFIRMATION_PROCESSING_QUEUE_URL!,
        deadLetterQueueUrl:
          config.SQS_CONFIRMATION_PROCESSING_DEAD_LETTER_QUEUE_URL,
      })
    : createConfirmationProcessingQueue({
        redisUrl: config.REDIS_URL!,
        queueName: config.CONFIRMATION_PROCESSING_QUEUE_NAME,
      });
const onScanConfirmed = createConfirmationProcessingHandler({
  database: coreDatabase.db,
});
const confirmationProcessingWorker =
  config.QUEUE_DRIVER === "sqs"
    ? createSqsConfirmationProcessingWorker({
        queueUrl: config.SQS_CONFIRMATION_PROCESSING_QUEUE_URL!,
        maxAttempts: config.SQS_MAX_RECEIVE_COUNT,
        visibilityTimeoutSeconds: config.SQS_VISIBILITY_TIMEOUT_SECONDS,
        onScanConfirmed,
        onError: (error) => {
          console.error("[worker] SQS confirmation-processing consumer error", {
            errorName: error.name,
          });
        },
      })
    : createConfirmationProcessingWorker({
        redisUrl: config.REDIS_URL!,
        queueName: config.CONFIRMATION_PROCESSING_QUEUE_NAME,
        onScanConfirmed,
        onError: (error) => {
          console.error(
            "[worker] BullMQ confirmation-processing consumer error",
            { errorName: error.name },
          );
        },
      });

const confirmationCompletionQueue =
  config.QUEUE_DRIVER === "sqs"
    ? createSqsConfirmationCompletionQueue({
        queueUrl: config.SQS_CONFIRMATION_COMPLETION_QUEUE_URL!,
        deadLetterQueueUrl:
          config.SQS_CONFIRMATION_COMPLETION_DEAD_LETTER_QUEUE_URL,
      })
    : createConfirmationCompletionQueue({
        redisUrl: config.REDIS_URL!,
        queueName: config.CONFIRMATION_COMPLETION_QUEUE_NAME,
      });
const onConfirmationCompleted = createConfirmationCompletionHandler({
  database: scanDatabase.db,
});
const confirmationCompletionWorker =
  config.QUEUE_DRIVER === "sqs"
    ? createSqsConfirmationCompletionWorker({
        queueUrl: config.SQS_CONFIRMATION_COMPLETION_QUEUE_URL!,
        maxAttempts: config.SQS_MAX_RECEIVE_COUNT,
        visibilityTimeoutSeconds: config.SQS_VISIBILITY_TIMEOUT_SECONDS,
        onConfirmationCompleted,
        onError: (error) => {
          console.error("[worker] SQS confirmation-completion consumer error", {
            errorName: error.name,
          });
        },
      })
    : createConfirmationCompletionWorker({
        redisUrl: config.REDIS_URL!,
        queueName: config.CONFIRMATION_COMPLETION_QUEUE_NAME,
        onConfirmationCompleted,
        onError: (error) => {
          console.error(
            "[worker] BullMQ confirmation-completion consumer error",
            { errorName: error.name },
          );
        },
      });

let stopping = false;
let nextPoll: NodeJS.Timeout | undefined;
let activePoll: Promise<void> | undefined;
const healthFile = process.env.WORKER_HEALTH_FILE;

async function recordHeartbeat() {
  if (!healthFile) return;
  try {
    await writeFile(healthFile, new Date().toISOString(), "utf8");
  } catch (error) {
    console.error("[worker] health heartbeat failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

/**
 * P4.2 Task 5 (ADR-0028): scoped to `scan.analyze.v1` alone.
 * `dispatchNextOutboxMessage` now claims only the topics named in its
 * registry, so a deep analysis backlog can grow this loop's own queue
 * arbitrarily long without ever affecting `dispatchAvailableConfirmedEvents`
 * below -- they run independent `WHERE topic = ANY (...)` queries against
 * the same table rather than competing for one shared "oldest across every
 * topic" claim, which is what previously let an analysis burst starve
 * confirmation dispatch.
 */
async function dispatchAvailableAnalysisJobs() {
  while (!stopping) {
    const result = await dispatchNextOutboxMessage(scanDatabase.db, {
      [ANALYZE_SCAN_JOB]: async (payload, idempotencyKey) => {
        await queue.enqueueAnalyzeScan(
          payload as AnalyzeScanJob,
          idempotencyKey,
        );
      },
    });

    if (result.status !== "published") {
      return;
    }
    console.info("[worker] outbox_message_published", {
      messageId: result.messageId,
      jobId: result.jobId,
    });
    await recordHeartbeat();
  }
}

async function poll() {
  try {
    await dispatchAvailableAnalysisJobs();
  } catch (error) {
    console.error("[worker] outbox polling failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  } finally {
    await recordHeartbeat();
    if (!stopping) {
      nextPoll = setTimeout(runPoll, config.OUTBOX_POLL_INTERVAL_MS);
    }
  }
}

function runPoll() {
  activePoll = poll().finally(() => {
    activePoll = undefined;
  });
}

let nextConfirmedEventPoll: NodeJS.Timeout | undefined;
let activeConfirmedEventPoll: Promise<void> | undefined;

/**
 * P4.2 Task 5 (ADR-0028): hop 1 -> 2 dispatch, scoped to `scan.confirmed.v1`
 * alone and run on its own, faster `CONFIRMATION_DISPATCH_POLL_INTERVAL_MS`
 * schedule -- independent of `dispatchAvailableAnalysisJobs` above, per the
 * isolation note on `dispatchNextOutboxMessage` itself. This is the loop
 * that used to be merged into a single combined dispatch pass with analysis;
 * splitting it is what actually fixes the starvation the roadmap names, not
 * just the topic-scoped query alone -- a merged loop would still process
 * one topic's full backlog before returning to poll the other.
 */
async function dispatchAvailableConfirmedEvents() {
  while (!stopping) {
    const result = await dispatchNextOutboxMessage(scanDatabase.db, {
      [SCAN_CONFIRMED_EVENT]: async (payload, idempotencyKey) => {
        await confirmationProcessingQueue.enqueue(
          payload as ScanConfirmedEvent,
          idempotencyKey,
        );
      },
    });

    if (result.status !== "published") {
      return;
    }
    console.info("[worker] scan_confirmed_event_published", {
      messageId: result.messageId,
      jobId: result.jobId,
    });
    await recordHeartbeat();
  }
}

async function confirmedEventPoll() {
  try {
    await dispatchAvailableConfirmedEvents();
  } catch (error) {
    console.error("[worker] scan-confirmed-event polling failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  } finally {
    await recordHeartbeat();
    if (!stopping) {
      nextConfirmedEventPoll = setTimeout(
        runConfirmedEventPoll,
        config.CONFIRMATION_DISPATCH_POLL_INTERVAL_MS,
      );
    }
  }
}

function runConfirmedEventPoll() {
  activeConfirmedEventPoll = confirmedEventPoll().finally(() => {
    activeConfirmedEventPoll = undefined;
  });
}

let nextConfirmationReceiptPoll: NodeJS.Timeout | undefined;
let activeConfirmationReceiptPoll: Promise<void> | undefined;

/**
 * P4.2 Task 3's second dispatch loop (hop 2 -> 3): drains
 * `confirmation_receipts` the same way `dispatchAvailableConfirmedEvents`
 * drains `outbox_messages`, but against the dedicated, single-topic
 * dispatcher (`dispatchNextConfirmationReceipt`) rather than the generalized
 * one -- it already had its own table, so it never shared a claim query with
 * analysis dispatch. P4.2 Task 5 gives it the same dedicated
 * `CONFIRMATION_DISPATCH_POLL_INTERVAL_MS` schedule as the hop 1 -> 2 loop
 * above instead of reusing `OUTBOX_POLL_INTERVAL_MS`, since both hops are
 * part of the same confirmation-to-library-visible latency budget.
 */
async function dispatchAvailableConfirmationReceipts() {
  while (!stopping) {
    const result = await dispatchNextConfirmationReceipt(
      coreDatabase.db,
      async (payload, idempotencyKey) => {
        await confirmationCompletionQueue.enqueue(
          payload as ConfirmationCompletedEvent,
          idempotencyKey,
        );
      },
    );

    if (result.status !== "published") {
      return;
    }
    console.info("[worker] confirmation_receipt_published", {
      receiptId: result.receiptId,
      idempotencyKey: result.idempotencyKey,
    });
    await recordHeartbeat();
  }
}

async function confirmationReceiptPoll() {
  try {
    await dispatchAvailableConfirmationReceipts();
  } catch (error) {
    console.error("[worker] confirmation-receipt polling failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  } finally {
    if (!stopping) {
      nextConfirmationReceiptPoll = setTimeout(
        runConfirmationReceiptPoll,
        config.CONFIRMATION_DISPATCH_POLL_INTERVAL_MS,
      );
    }
  }
}

function runConfirmationReceiptPoll() {
  activeConfirmationReceiptPoll = confirmationReceiptPoll().finally(() => {
    activeConfirmationReceiptPoll = undefined;
  });
}

let nextCleanupPoll: NodeJS.Timeout | undefined;
let activeCleanupPoll: Promise<void> | undefined;

async function cleanupAbandonedUploads() {
  const olderThan = new Date(
    Date.now() - config.ABANDONED_UPLOAD_TTL_HOURS * 60 * 60 * 1_000,
  );
  const canceled = await cleanupAbandonedScans(scanDatabase.db, {
    olderThan,
    limit: config.ABANDONED_UPLOAD_CLEANUP_BATCH_SIZE,
  });
  if (canceled.length === 0) {
    return;
  }
  console.info("[worker] abandoned_scans_canceled", {
    count: canceled.length,
  });
  await Promise.all(
    canceled.flatMap((scan) =>
      scan.imageObjectKeys.map(async (objectKey) => {
        try {
          await storage.deleteObject(objectKey);
        } catch (error) {
          console.error(
            "[worker] failed to delete an abandoned upload's object",
            {
              objectKey,
              errorName: error instanceof Error ? error.name : "UnknownError",
            },
          );
        }
      }),
    ),
  );
}

async function cleanupPoll() {
  try {
    await cleanupAbandonedUploads();
  } catch (error) {
    console.error("[worker] abandoned upload cleanup failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  } finally {
    if (!stopping) {
      nextCleanupPoll = setTimeout(
        runCleanupPoll,
        config.ABANDONED_UPLOAD_CLEANUP_INTERVAL_MS,
      );
    }
  }
}

function runCleanupPoll() {
  activeCleanupPoll = cleanupPoll().finally(() => {
    activeCleanupPoll = undefined;
  });
}

let nextReconciliationPoll: NodeJS.Timeout | undefined;
let activeReconciliationPoll: Promise<void> | undefined;

/**
 * P4.2 Task 4 (ADR-0028 amendment): the background half of safe retry --
 * finds confirmations that have sat `pending` past a UX-driven staleness
 * threshold (a BullMQ job that exhausted its attempts, an SQS message that
 * dead-lettered, a slow deploy window) and re-drives each one directly via
 * `reconcileScanConfirmation`, the same idempotent function the user-facing
 * retry endpoint calls. One candidate's failure (e.g. the Task-6-documented
 * FK violation when its user was deleted mid-flight) is logged and does not
 * stop the sweep from reconciling the rest.
 */
async function reconcileStaleConfirmations() {
  const olderThan = new Date(
    Date.now() - config.CONFIRMATION_RECONCILIATION_STALE_AFTER_MS,
  );
  const stale = await listStalePendingConfirmations(scanDatabase.db, {
    olderThan,
    limit: config.CONFIRMATION_RECONCILIATION_BATCH_SIZE,
  });
  for (const candidate of stale) {
    try {
      await reconcileScanConfirmation(
        scanDatabase.db,
        coreDatabase.db,
        candidate,
      );
      console.info("[worker] confirmation_reconciled", {
        scanId: candidate.scanId,
      });
    } catch (error) {
      console.error("[worker] confirmation reconciliation failed", {
        scanId: candidate.scanId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}

async function reconciliationPoll() {
  try {
    await reconcileStaleConfirmations();
  } catch (error) {
    console.error("[worker] confirmation reconciliation sweep failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  } finally {
    if (!stopping) {
      nextReconciliationPoll = setTimeout(
        runReconciliationPoll,
        config.CONFIRMATION_RECONCILIATION_POLL_INTERVAL_MS,
      );
    }
  }
}

function runReconciliationPoll() {
  activeReconciliationPoll = reconciliationPoll().finally(() => {
    activeReconciliationPoll = undefined;
  });
}

let nextAccountDeletionPoll: NodeJS.Timeout | undefined;
let activeAccountDeletionPoll: Promise<void> | undefined;

/**
 * P4.2 Task 6 (new ADR): the background half of the durable account-deletion
 * workflow -- finalizes every account whose deletion was requested
 * (`deleteAccount`) and which has since drained to zero `pending`
 * scan_confirmations (via the confirmation-reconciliation sweep above, or
 * the normal pipeline). One candidate's failure is logged and does not stop
 * the sweep from finalizing the rest. Storage cleanup mirrors the route's
 * own best-effort posture (ADR-0014): a failed object delete is logged, not
 * retried inline, and does not undo the already-committed database delete.
 */
async function finalizeReadyAccountDeletions() {
  const ready = await listAccountsPendingDeletion(coreDatabase.db, {
    limit: config.ACCOUNT_DELETION_BATCH_SIZE,
  });
  for (const userId of ready) {
    try {
      const result = await finalizeAccountDeletion(
        scanDatabase.db,
        coreDatabase.db,
        { userId },
      );
      if (!result) {
        continue;
      }
      console.info("[worker] account_deletion_finalized", {
        userId: result.id,
      });
      await Promise.all(
        result.objectKeys.map(async (objectKey) => {
          try {
            await storage.deleteObject(objectKey);
          } catch (error) {
            console.error(
              "[worker] failed to delete an object during account deletion finalization",
              {
                objectKey,
                errorName: error instanceof Error ? error.name : "UnknownError",
              },
            );
          }
        }),
      );
    } catch (error) {
      console.error("[worker] account deletion finalization failed", {
        userId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}

async function accountDeletionPoll() {
  try {
    await finalizeReadyAccountDeletions();
  } catch (error) {
    console.error("[worker] account deletion sweep failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  } finally {
    if (!stopping) {
      nextAccountDeletionPoll = setTimeout(
        runAccountDeletionPoll,
        config.ACCOUNT_DELETION_POLL_INTERVAL_MS,
      );
    }
  }
}

function runAccountDeletionPoll() {
  activeAccountDeletionPoll = accountDeletionPoll().finally(() => {
    activeAccountDeletionPoll = undefined;
  });
}

async function shutdown(signal: (typeof shutdownSignals)[number]) {
  if (stopping) {
    return;
  }
  stopping = true;
  if (nextPoll) {
    clearTimeout(nextPoll);
  }
  if (nextCleanupPoll) {
    clearTimeout(nextCleanupPoll);
  }
  if (nextConfirmedEventPoll) {
    clearTimeout(nextConfirmedEventPoll);
  }
  if (nextConfirmationReceiptPoll) {
    clearTimeout(nextConfirmationReceiptPoll);
  }
  if (nextReconciliationPoll) {
    clearTimeout(nextReconciliationPoll);
  }
  if (nextAccountDeletionPoll) {
    clearTimeout(nextAccountDeletionPoll);
  }
  console.info(`[worker] received ${signal}; shutting down cleanly`);
  await Promise.allSettled([
    analysisWorker.close(),
    confirmationProcessingWorker.close(),
    confirmationCompletionWorker.close(),
    activePoll,
    activeCleanupPoll,
    activeConfirmedEventPoll,
    activeConfirmationReceiptPoll,
    activeReconciliationPoll,
    activeAccountDeletionPoll,
  ]);
  await metricsPublisher.close();
  await queue.close();
  await confirmationProcessingQueue.close();
  await confirmationCompletionQueue.close();
  await Promise.all([scanDatabase.close(), coreDatabase.close()]);
  console.info("[worker] shutdown complete");
}

for (const signal of shutdownSignals) {
  process.once(signal, () => void shutdown(signal));
}

console.info("[worker] started", {
  deploymentVersion: config.DEPLOYMENT_VERSION,
  queueDriver: config.QUEUE_DRIVER,
  outboxPollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
  confirmationDispatchPollIntervalMs:
    config.CONFIRMATION_DISPATCH_POLL_INTERVAL_MS,
  analysisConcurrency: config.ANALYSIS_CONCURRENCY,
  cloudWatchMetricsEnabled: config.CLOUDWATCH_METRICS_ENABLED,
  abandonedUploadTtlHours: config.ABANDONED_UPLOAD_TTL_HOURS,
  abandonedUploadCleanupIntervalMs: config.ABANDONED_UPLOAD_CLEANUP_INTERVAL_MS,
  confirmationReconciliationPollIntervalMs:
    config.CONFIRMATION_RECONCILIATION_POLL_INTERVAL_MS,
  confirmationReconciliationStaleAfterMs:
    config.CONFIRMATION_RECONCILIATION_STALE_AFTER_MS,
  accountDeletionPollIntervalMs: config.ACCOUNT_DELETION_POLL_INTERVAL_MS,
});
void recordHeartbeat();
runPoll();
runConfirmedEventPoll();
runCleanupPoll();
runConfirmationReceiptPoll();
runReconciliationPoll();
runAccountDeletionPoll();
