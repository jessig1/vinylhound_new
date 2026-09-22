import {
  ALBUM_IDENTIFICATION_PROMPT_VERSION,
  createOpenAIAlbumIdentifier,
} from "@vinylhound/ai";
import { loadQueueWorkerConfig } from "@vinylhound/config";
import {
  ANALYZE_SCAN_JOB,
  CONFIRMATION_COMPLETED_EVENT_CONTRACT,
  SCAN_CONFIRMED_EVENT,
  SCAN_CONFIRMED_EVENT_CONTRACT,
  type AnalyzeScanJob,
  type ConfirmationCompletedEvent,
  type ScanConfirmedEvent,
} from "@vinylhound/contracts";
import {
  coreDatabaseOptionsFromConfig,
  createCoreDatabase,
  createScanDatabase,
  dispatchNextConfirmationReceipt,
  dispatchNextOutboxMessage,
  scanDatabaseOptionsFromConfig,
} from "@vinylhound/database";
import {
  createSqsConfirmationCompletionQueue,
  createSqsConfirmationProcessingQueue,
  createSqsScanQueue,
  parseSqsAnalyzeScanMessage,
  parseSqsTopicMessage,
} from "@vinylhound/queue";
import { createS3ObjectStorage } from "@vinylhound/storage";

import { createScanAnalysisHandler } from "./analysis-handler.ts";
import { createConfirmationCompletionHandler } from "./confirmation-completion-handler.ts";
import { createConfirmationProcessingHandler } from "./confirmation-processing-handler.ts";
import { requireOpenAiApiKey } from "./require-openai-key.ts";

interface SqsLambdaRecord {
  messageId: string;
  body: string;
  eventSourceARN?: string;
  attributes?: { ApproximateReceiveCount?: string };
}

interface LambdaEvent {
  source?: string;
  Records?: SqsLambdaRecord[];
}

const config = loadQueueWorkerConfig();
if (
  config.QUEUE_DRIVER !== "sqs" ||
  !config.SQS_QUEUE_URL ||
  !config.SQS_CONFIRMATION_PROCESSING_QUEUE_URL ||
  !config.SQS_CONFIRMATION_COMPLETION_QUEUE_URL
) {
  throw new Error(
    "The Lambda worker requires QUEUE_DRIVER=sqs and all three queue URLs " +
      "(SQS_QUEUE_URL, SQS_CONFIRMATION_PROCESSING_QUEUE_URL, " +
      "SQS_CONFIRMATION_COMPLETION_QUEUE_URL).",
  );
}
requireOpenAiApiKey(config.OPENAI_API_KEY);

const scanDatabase = createScanDatabase(scanDatabaseOptionsFromConfig(config));
const coreDatabase = createCoreDatabase(coreDatabaseOptionsFromConfig(config));
const queue = createSqsScanQueue({
  queueUrl: config.SQS_QUEUE_URL,
  deadLetterQueueUrl: config.SQS_DEAD_LETTER_QUEUE_URL,
});
const confirmationProcessingQueue = createSqsConfirmationProcessingQueue({
  queueUrl: config.SQS_CONFIRMATION_PROCESSING_QUEUE_URL,
  deadLetterQueueUrl: config.SQS_CONFIRMATION_PROCESSING_DEAD_LETTER_QUEUE_URL,
});
const confirmationCompletionQueue = createSqsConfirmationCompletionQueue({
  queueUrl: config.SQS_CONFIRMATION_COMPLETION_QUEUE_URL,
  deadLetterQueueUrl: config.SQS_CONFIRMATION_COMPLETION_DEAD_LETTER_QUEUE_URL,
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
// P4.2 Task 3 (ADR-0028): both the "core" consumer and the "scan" projector
// run in this same Lambda today -- a transactional boundary, not a process
// one, until Task 7's physical cutover (see ADR-0027).
const processScanConfirmed = createConfirmationProcessingHandler({
  database: coreDatabase.db,
});
const applyConfirmationCompleted = createConfirmationCompletionHandler({
  database: scanDatabase.db,
});

/**
 * P4.2 Task 5 (ADR-0028): three topic-scoped passes, not one combined
 * analysis+confirmation pass. `dispatchNextOutboxMessage` claims only the
 * topics in its registry, so this invocation's confirmed-event pass can
 * never be blocked behind (or have its rows claimed by) the analysis pass --
 * each gets its own 100-message budget. Confirmed events are drained first,
 * deliberately: they are the latency-sensitive hop of this pipeline, and
 * this Lambda's own EventBridge schedule (`infra/terraform/development`'s
 * `rate(1 minute)` "outbox" rule) is the dominant term in this topology's
 * confirmation-to-library latency, far larger than either dispatch loop's
 * own claim/enqueue cost -- ordering only controls which pass runs first
 * within one invocation, not that schedule. That schedule is a pre-existing,
 * intentionally coarse choice for a cost-optimized development-tier Lambda,
 * out of scope for this task's own latency target (`docs/roadmap/
 * p4.2-scans-async-confirmation.md`'s "Additional development service
 * Lambdas ... are outside this scope"); staging/production instead run the
 * long-running `apps/worker/src/index.ts` process, whose two dispatch loops
 * this task tuned directly.
 */
async function dispatchOutbox() {
  let confirmedEventsPublished = 0;
  while (confirmedEventsPublished < 100) {
    const result = await dispatchNextOutboxMessage(scanDatabase.db, {
      [SCAN_CONFIRMED_EVENT]: async (payload, idempotencyKey) => {
        await confirmationProcessingQueue.enqueue(
          payload as ScanConfirmedEvent,
          idempotencyKey,
        );
      },
    });
    if (result.status !== "published") break;
    confirmedEventsPublished += 1;
  }

  let published = 0;
  while (published < 100) {
    const result = await dispatchNextOutboxMessage(scanDatabase.db, {
      [ANALYZE_SCAN_JOB]: async (payload, idempotencyKey) => {
        await queue.enqueueAnalyzeScan(
          payload as AnalyzeScanJob,
          idempotencyKey,
        );
      },
    });
    if (result.status !== "published") break;
    published += 1;
  }

  let confirmationReceiptsPublished = 0;
  while (confirmationReceiptsPublished < 100) {
    const result = await dispatchNextConfirmationReceipt(
      coreDatabase.db,
      async (payload, idempotencyKey) => {
        await confirmationCompletionQueue.enqueue(
          payload as ConfirmationCompletedEvent,
          idempotencyKey,
        );
      },
    );
    if (result.status !== "published") break;
    confirmationReceiptsPublished += 1;
  }

  return { published, confirmedEventsPublished, confirmationReceiptsPublished };
}

/** The queue name is the last path segment of its URL; an SQS-populated
 * `eventSourceARN` ends with the same name (`arn:aws:sqs:<region>:<account>:<name>`).
 * Routing on this avoids needing a separate ARN configured for each queue. */
function sqsQueueNameFromUrl(url: string) {
  return url.split("/").at(-1);
}
function sqsQueueNameFromArn(arn: string | undefined) {
  return arn?.split(":").at(-1);
}

const scanQueueName = sqsQueueNameFromUrl(config.SQS_QUEUE_URL);
const confirmationProcessingQueueName = sqsQueueNameFromUrl(
  config.SQS_CONFIRMATION_PROCESSING_QUEUE_URL,
);
const confirmationCompletionQueueName = sqsQueueNameFromUrl(
  config.SQS_CONFIRMATION_COMPLETION_QUEUE_URL,
);

async function handleRecord(record: SqsLambdaRecord) {
  const sourceQueueName = sqsQueueNameFromArn(record.eventSourceARN);
  const deliveryAttempt = Math.max(
    1,
    Number(record.attributes?.ApproximateReceiveCount ?? 1),
  );

  if (sourceQueueName === confirmationProcessingQueueName) {
    const decoded = parseSqsTopicMessage(
      record.body,
      SCAN_CONFIRMED_EVENT_CONTRACT,
    );
    await processScanConfirmed(decoded.job, {
      jobId: decoded.idempotencyKey ?? record.messageId,
      deliveryAttempt,
      maxAttempts: config.SQS_MAX_RECEIVE_COUNT,
    });
    return;
  }

  if (sourceQueueName === confirmationCompletionQueueName) {
    const decoded = parseSqsTopicMessage(
      record.body,
      CONFIRMATION_COMPLETED_EVENT_CONTRACT,
    );
    await applyConfirmationCompleted(decoded.job, {
      jobId: decoded.idempotencyKey ?? record.messageId,
      deliveryAttempt,
      maxAttempts: config.SQS_MAX_RECEIVE_COUNT,
    });
    return;
  }

  // Falls through to the analyze-scan queue for an unrecognized or absent
  // `eventSourceARN` (e.g. a local invocation), matching this handler's
  // only behavior before P4.2 Task 3 added the other two queues.
  if (sourceQueueName !== undefined && sourceQueueName !== scanQueueName) {
    throw new Error(`Unrecognized SQS source queue: ${sourceQueueName}`);
  }
  const decoded = parseSqsAnalyzeScanMessage(record.body);
  await analyzeScan(decoded.job, {
    jobId: decoded.idempotencyKey ?? record.messageId,
    deliveryAttempt,
    maxAttempts: config.SQS_MAX_RECEIVE_COUNT,
  });
}

export async function handler(event: LambdaEvent) {
  if (event.source === "aws.events") {
    return dispatchOutbox();
  }

  const batchItemFailures: Array<{ itemIdentifier: string }> = [];
  for (const record of event.Records ?? []) {
    try {
      await handleRecord(record);
    } catch (error) {
      console.error("[worker-lambda] message processing failed", {
        messageId: record.messageId,
        eventSourceARN: record.eventSourceARN,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
