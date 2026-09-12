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
  createSqsScanQueue,
  parseSqsAnalyzeScanMessage,
} from "@vinylhound/queue";
import { createS3ObjectStorage } from "@vinylhound/storage";

import { createScanAnalysisHandler } from "./analysis-handler.ts";

interface SqsLambdaRecord {
  messageId: string;
  body: string;
  attributes?: { ApproximateReceiveCount?: string };
}

interface LambdaEvent {
  source?: string;
  Records?: SqsLambdaRecord[];
}

const config = loadQueueWorkerConfig();
if (config.QUEUE_DRIVER !== "sqs" || !config.SQS_QUEUE_URL) {
  throw new Error(
    "The Lambda worker requires QUEUE_DRIVER=sqs and SQS_QUEUE_URL.",
  );
}
if (!config.OPENAI_API_KEY) {
  throw new Error("The Lambda worker requires OPENAI_API_KEY.");
}

const database = createDatabase(databaseOptionsFromConfig(config));
const queue = createSqsScanQueue({
  queueUrl: config.SQS_QUEUE_URL,
  deadLetterQueueUrl: config.SQS_DEAD_LETTER_QUEUE_URL,
});
const storage = createS3ObjectStorage({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  bucket: config.S3_BUCKET,
  accessKeyId: config.S3_ACCESS_KEY_ID,
  secretAccessKey: config.S3_SECRET_ACCESS_KEY,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
});
const analyzeScan = createScanAnalysisHandler({
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
});

async function dispatchOutbox() {
  let published = 0;
  while (published < 100) {
    const result = await dispatchNextOutboxMessage(
      database.db,
      async (job, idempotencyKey) => {
        await queue.enqueueAnalyzeScan(job, idempotencyKey);
      },
    );
    if (result.status !== "published") break;
    published += 1;
  }
  return { published };
}

export async function handler(event: LambdaEvent) {
  if (event.source === "aws.events") {
    return dispatchOutbox();
  }

  const batchItemFailures: Array<{ itemIdentifier: string }> = [];
  for (const record of event.Records ?? []) {
    try {
      const decoded = parseSqsAnalyzeScanMessage(record.body);
      await analyzeScan(decoded.job, {
        jobId: decoded.idempotencyKey ?? record.messageId,
        deliveryAttempt: Math.max(
          1,
          Number(record.attributes?.ApproximateReceiveCount ?? 1),
        ),
        maxAttempts: config.SQS_MAX_RECEIVE_COUNT,
      });
    } catch (error) {
      console.error("[worker-lambda] scan processing failed", {
        messageId: record.messageId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
