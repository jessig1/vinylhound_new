import {
  ALBUM_IDENTIFICATION_PROMPT_VERSION,
  createOpenAIAlbumIdentifier,
} from "@vinylhound/ai";
import { loadQueueWorkerConfig } from "@vinylhound/config";
import {
  cleanupAbandonedScans,
  createDatabase,
  databaseOptionsFromConfig,
  dispatchNextOutboxMessage,
} from "@vinylhound/database";
import {
  createAnalyzeScanWorker,
  createBullMqScanQueue,
  createSqsAnalyzeScanWorker,
  createSqsScanQueue,
} from "@vinylhound/queue";
import { createS3ObjectStorage } from "@vinylhound/storage";
import { writeFile } from "node:fs/promises";

import { createScanAnalysisHandler } from "./analysis-handler.js";
import { startQueueMetricsPublisher } from "./metrics.js";

const shutdownSignals = ["SIGINT", "SIGTERM"] as const;
const config = loadQueueWorkerConfig();
const database = createDatabase(databaseOptionsFromConfig(config));
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
  database: database.db,
  storage,
  identifier: createOpenAIAlbumIdentifier({
    apiKey: config.OPENAI_API_KEY ?? "disabled",
    model: config.OPENAI_VISION_MODEL,
    imageDetail: config.OPENAI_IMAGE_DETAIL,
    timeoutMs: config.OPENAI_TIMEOUT_MS,
  }),
  configuredModel: config.OPENAI_VISION_MODEL,
  promptVersion: ALBUM_IDENTIFICATION_PROMPT_VERSION,
});
const analysisWorker = config.OPENAI_API_KEY
  ? config.QUEUE_DRIVER === "sqs"
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
      })
  : undefined;

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

async function dispatchAvailableMessages() {
  while (!stopping) {
    const result = await dispatchNextOutboxMessage(
      database.db,
      async (job, idempotencyKey) => {
        await queue.enqueueAnalyzeScan(job, idempotencyKey);
      },
    );

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
    await dispatchAvailableMessages();
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

let nextCleanupPoll: NodeJS.Timeout | undefined;
let activeCleanupPoll: Promise<void> | undefined;

async function cleanupAbandonedUploads() {
  const olderThan = new Date(
    Date.now() - config.ABANDONED_UPLOAD_TTL_HOURS * 60 * 60 * 1_000,
  );
  const canceled = await cleanupAbandonedScans(database.db, {
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
  console.info(`[worker] received ${signal}; shutting down cleanly`);
  await Promise.allSettled([
    analysisWorker?.close(),
    activePoll,
    activeCleanupPoll,
  ]);
  await metricsPublisher.close();
  await queue.close();
  await database.close();
  console.info("[worker] shutdown complete");
}

for (const signal of shutdownSignals) {
  process.once(signal, () => void shutdown(signal));
}

console.info("[worker] started", {
  deploymentVersion: config.DEPLOYMENT_VERSION,
  queueDriver: config.QUEUE_DRIVER,
  outboxPollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
  analysisEnabled: Boolean(analysisWorker),
  analysisConcurrency: config.ANALYSIS_CONCURRENCY,
  cloudWatchMetricsEnabled: config.CLOUDWATCH_METRICS_ENABLED,
  abandonedUploadTtlHours: config.ABANDONED_UPLOAD_TTL_HOURS,
  abandonedUploadCleanupIntervalMs: config.ABANDONED_UPLOAD_CLEANUP_INTERVAL_MS,
});
void recordHeartbeat();
runPoll();
runCleanupPoll();
