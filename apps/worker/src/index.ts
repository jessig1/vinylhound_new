import {
  ALBUM_IDENTIFICATION_PROMPT_VERSION,
  createOpenAIAlbumIdentifier,
} from "@vinylhound/ai";
import { loadQueueWorkerConfig } from "@vinylhound/config";
import {
  createDatabase,
  databaseOptionsFromConfig,
  dispatchNextOutboxMessage,
} from "@vinylhound/database";
import {
  createAnalyzeScanWorker,
  createBullMqScanQueue,
} from "@vinylhound/queue";
import { createS3ObjectStorage } from "@vinylhound/storage";
import { writeFile } from "node:fs/promises";

import { createScanAnalysisHandler } from "./analysis-handler.js";
import { startQueueMetricsPublisher } from "./metrics.js";

const shutdownSignals = ["SIGINT", "SIGTERM"] as const;
const config = loadQueueWorkerConfig();
const database = createDatabase(databaseOptionsFromConfig(config));
const queue = createBullMqScanQueue({
  redisUrl: config.REDIS_URL,
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
const analysisWorker = config.OPENAI_API_KEY
  ? createAnalyzeScanWorker({
      redisUrl: config.REDIS_URL,
      queueName: config.SCAN_QUEUE_NAME,
      concurrency: config.ANALYSIS_CONCURRENCY,
      onAnalyzeScan: createScanAnalysisHandler({
        database: database.db,
        storage,
        identifier: createOpenAIAlbumIdentifier({
          apiKey: config.OPENAI_API_KEY,
          model: config.OPENAI_VISION_MODEL,
          imageDetail: config.OPENAI_IMAGE_DETAIL,
          timeoutMs: config.OPENAI_TIMEOUT_MS,
        }),
        configuredModel: config.OPENAI_VISION_MODEL,
        promptVersion: ALBUM_IDENTIFICATION_PROMPT_VERSION,
      }),
      onError: (error) => {
        console.error("[worker] scan consumer error", {
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

async function shutdown(signal: (typeof shutdownSignals)[number]) {
  if (stopping) {
    return;
  }
  stopping = true;
  if (nextPoll) {
    clearTimeout(nextPoll);
  }
  console.info(`[worker] received ${signal}; shutting down cleanly`);
  await Promise.allSettled([analysisWorker?.close(), activePoll]);
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
  outboxPollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
  analysisEnabled: Boolean(analysisWorker),
  analysisConcurrency: config.ANALYSIS_CONCURRENCY,
  cloudWatchMetricsEnabled: config.CLOUDWATCH_METRICS_ENABLED,
});
void recordHeartbeat();
runPoll();
