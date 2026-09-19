import { randomUUID } from "node:crypto";

import type { AlbumIdentifier } from "@vinylhound/ai";
import { loadQueueWorkerConfig } from "@vinylhound/config";
import {
  ANALYZE_SCAN_JOB,
  SCAN_CONFIRMED_EVENT,
  type AnalyzeScanJob,
  type ConfirmationCompletedEvent,
  type ScanConfirmedEvent,
} from "@vinylhound/contracts";
import {
  createDatabase,
  databaseOptionsFromConfig,
  dispatchNextConfirmationReceipt,
  dispatchNextOutboxMessage,
} from "@vinylhound/database";
import {
  createAnalyzeScanWorker,
  createBullMqScanQueue,
  createConfirmationCompletionQueue,
  createConfirmationCompletionWorker,
  createConfirmationProcessingQueue,
  createConfirmationProcessingWorker,
} from "@vinylhound/queue";
import { createS3ObjectStorage } from "@vinylhound/storage";

import { createScanAnalysisHandler } from "./analysis-handler.ts";
import { createConfirmationCompletionHandler } from "./confirmation-completion-handler.ts";
import { createConfirmationProcessingHandler } from "./confirmation-processing-handler.ts";

// End-to-end test worker: runs the real outbox publisher, queue consumer,
// storage reads, and persistence with a deterministic identifier instead of
// the OpenAI adapter, so browser tests never make billable provider calls.

const config = loadQueueWorkerConfig();

if (!config.DATABASE_URL.includes("vinylhound_e2e")) {
  throw new Error(
    "Refusing to start: the e2e worker must point at the vinylhound_e2e database.",
  );
}

const syntheticIdentifier: AlbumIdentifier = {
  async identify() {
    return {
      identification: {
        candidates: [
          {
            artist: "The Vinyl Hounds",
            title: "Automated Test Pressing",
            releaseYear: 2024,
            label: "E2E Records",
            catalogNumber: null,
            barcode: null,
            confidence: 0.97,
            evidence: ["Synthetic identification for end-to-end tests."],
            warnings: [],
          },
          {
            artist: "The Vinyl Hounds",
            title: "Alternate Take",
            releaseYear: 2022,
            label: null,
            catalogNumber: null,
            barcode: null,
            confidence: 0.41,
            evidence: [],
            warnings: ["Low-confidence synthetic alternate."],
          },
        ],
        observations: ["Synthetic e2e analysis."],
        needsReviewReasons: [],
      },
      metadata: {
        provider: "openai",
        model: "e2e-synthetic-vision",
        promptVersion: "album-identification.e2e.v1",
        providerResponseId: `e2e-${randomUUID()}`,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    };
  },
};

const database = createDatabase(databaseOptionsFromConfig(config));
const queue = createBullMqScanQueue({
  redisUrl: config.REDIS_URL!,
  queueName: config.SCAN_QUEUE_NAME,
});
const storage = createS3ObjectStorage({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  bucket: config.S3_BUCKET,
  accessKeyId: config.S3_ACCESS_KEY_ID,
  secretAccessKey: config.S3_SECRET_ACCESS_KEY,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
});
const analysisWorker = createAnalyzeScanWorker({
  redisUrl: config.REDIS_URL!,
  queueName: config.SCAN_QUEUE_NAME,
  concurrency: config.ANALYSIS_CONCURRENCY,
  onAnalyzeScan: createScanAnalysisHandler({
    database: database.db,
    storage,
    identifier: syntheticIdentifier,
    configuredModel: "e2e-synthetic-vision",
    promptVersion: "album-identification.e2e.v1",
  }),
  onError: (error) => {
    console.error("[e2e-worker] scan consumer error", {
      errorName: error.name,
    });
  },
});

// P4.2 Task 3 (ADR-0028): the browser e2e suite confirms scans, so this
// worker must run the full pipeline, not just scan analysis, or a confirm
// click would hang forever waiting for a projection that never lands.
const confirmationProcessingQueue = createConfirmationProcessingQueue({
  redisUrl: config.REDIS_URL!,
  queueName: config.CONFIRMATION_PROCESSING_QUEUE_NAME,
});
const confirmationProcessingWorker = createConfirmationProcessingWorker({
  redisUrl: config.REDIS_URL!,
  queueName: config.CONFIRMATION_PROCESSING_QUEUE_NAME,
  onScanConfirmed: createConfirmationProcessingHandler({
    database: database.db,
  }),
  onError: (error) => {
    console.error("[e2e-worker] confirmation-processing consumer error", {
      errorName: error.name,
    });
  },
});
const confirmationCompletionQueue = createConfirmationCompletionQueue({
  redisUrl: config.REDIS_URL!,
  queueName: config.CONFIRMATION_COMPLETION_QUEUE_NAME,
});
const confirmationCompletionWorker = createConfirmationCompletionWorker({
  redisUrl: config.REDIS_URL!,
  queueName: config.CONFIRMATION_COMPLETION_QUEUE_NAME,
  onConfirmationCompleted: createConfirmationCompletionHandler({
    database: database.db,
  }),
  onError: (error) => {
    console.error("[e2e-worker] confirmation-completion consumer error", {
      errorName: error.name,
    });
  },
});

let stopping = false;
let nextPoll: NodeJS.Timeout | undefined;
let nextConfirmationReceiptPoll: NodeJS.Timeout | undefined;

async function poll() {
  try {
    while (!stopping) {
      const result = await dispatchNextOutboxMessage(database.db, {
        [ANALYZE_SCAN_JOB]: async (payload, idempotencyKey) => {
          await queue.enqueueAnalyzeScan(
            payload as AnalyzeScanJob,
            idempotencyKey,
          );
        },
        [SCAN_CONFIRMED_EVENT]: async (payload, idempotencyKey) => {
          await confirmationProcessingQueue.enqueue(
            payload as ScanConfirmedEvent,
            idempotencyKey,
          );
        },
      });
      if (result.status !== "published") {
        break;
      }
    }
  } catch (error) {
    console.error("[e2e-worker] outbox polling failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  } finally {
    if (!stopping) {
      nextPoll = setTimeout(() => void poll(), config.OUTBOX_POLL_INTERVAL_MS);
    }
  }
}

async function confirmationReceiptPoll() {
  try {
    while (!stopping) {
      const result = await dispatchNextConfirmationReceipt(
        database.db,
        async (payload, idempotencyKey) => {
          await confirmationCompletionQueue.enqueue(
            payload as ConfirmationCompletedEvent,
            idempotencyKey,
          );
        },
      );
      if (result.status !== "published") {
        break;
      }
    }
  } catch (error) {
    console.error("[e2e-worker] confirmation-receipt polling failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  } finally {
    if (!stopping) {
      nextConfirmationReceiptPoll = setTimeout(
        () => void confirmationReceiptPoll(),
        config.OUTBOX_POLL_INTERVAL_MS,
      );
    }
  }
}

async function shutdown() {
  if (stopping) {
    return;
  }
  stopping = true;
  if (nextPoll) {
    clearTimeout(nextPoll);
  }
  if (nextConfirmationReceiptPoll) {
    clearTimeout(nextConfirmationReceiptPoll);
  }
  await Promise.allSettled([
    analysisWorker.close(),
    confirmationProcessingWorker.close(),
    confirmationCompletionWorker.close(),
    queue.close(),
    confirmationProcessingQueue.close(),
    confirmationCompletionQueue.close(),
    database.close(),
  ]);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown());
}

console.info(
  `[e2e-worker] synthetic scan worker started; queue=${config.SCAN_QUEUE_NAME}`,
);
void poll();
void confirmationReceiptPoll();
