import { Queue, Worker, type JobsOptions } from "bullmq";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

import {
  ANALYZE_SCAN_JOB,
  AnalyzeScanJobSchema,
  type AnalyzeScanJob,
} from "@vinylhound/contracts";

export { ANALYZE_SCAN_JOB } from "@vinylhound/contracts";

export const DEFAULT_SCAN_QUEUE_NAME = "vinylhound-scans";

const analyzeScanJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 10_000 },
};

export interface ScanQueue {
  enqueueAnalyzeScan(
    payload: AnalyzeScanJob,
    idempotencyKey: string,
  ): Promise<{ jobId: string }>;
  getOperationalState(): Promise<{
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    oldestWaitingAgeSeconds: number;
  }>;
  close(): Promise<void>;
}

export interface BullMqScanQueueOptions {
  redisUrl: string;
  queueName?: string;
}

export function createBullMqScanQueue(
  options: BullMqScanQueueOptions,
): ScanQueue {
  const queue = new Queue<AnalyzeScanJob, void, typeof ANALYZE_SCAN_JOB>(
    options.queueName ?? DEFAULT_SCAN_QUEUE_NAME,
    { connection: { url: options.redisUrl } },
  );

  return {
    async enqueueAnalyzeScan(payload, idempotencyKey) {
      const validated = AnalyzeScanJobSchema.parse(payload);
      const job = await queue.add(ANALYZE_SCAN_JOB, validated, {
        ...analyzeScanJobOptions,
        jobId: idempotencyKey,
      });
      return { jobId: job.id! };
    },
    async getOperationalState() {
      const counts = await queue.getJobCounts(
        "wait",
        "active",
        "delayed",
        "failed",
      );
      const [oldestWaiting] = await queue.getJobs(["wait"], 0, 0, true);
      return {
        waiting: counts.wait ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        oldestWaitingAgeSeconds: oldestWaiting
          ? Math.max(
              0,
              Math.floor((Date.now() - oldestWaiting.timestamp) / 1000),
            )
          : 0,
      };
    },
    close: () => queue.close(),
  };
}

export interface SqsScanQueueOptions {
  queueUrl: string;
  deadLetterQueueUrl?: string;
  client?: SQSClient;
}

export function parseSqsAnalyzeScanMessage(body: string) {
  const decoded = JSON.parse(body) as {
    idempotencyKey?: unknown;
    job?: unknown;
  };
  return {
    idempotencyKey:
      typeof decoded.idempotencyKey === "string"
        ? decoded.idempotencyKey
        : undefined,
    job: AnalyzeScanJobSchema.parse(decoded.job),
  };
}

function approximateCount(
  attributes: Record<string, string> | undefined,
  name: string,
) {
  const value = Number(attributes?.[name] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function createSqsScanQueue(options: SqsScanQueueOptions): ScanQueue {
  const client = options.client ?? new SQSClient({});

  async function getAttributes(queueUrl: string) {
    const response = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: [
          "ApproximateNumberOfMessages",
          "ApproximateNumberOfMessagesNotVisible",
          "ApproximateNumberOfMessagesDelayed",
        ],
      }),
    );
    return response.Attributes;
  }

  return {
    async enqueueAnalyzeScan(payload, idempotencyKey) {
      const job = AnalyzeScanJobSchema.parse(payload);
      const fifo = options.queueUrl.endsWith(".fifo");
      await client.send(
        new SendMessageCommand({
          QueueUrl: options.queueUrl,
          MessageBody: JSON.stringify({ idempotencyKey, job }),
          ...(fifo
            ? {
                MessageGroupId: job.scanId,
                MessageDeduplicationId: idempotencyKey,
              }
            : {}),
        }),
      );
      return { jobId: idempotencyKey };
    },
    async getOperationalState() {
      const [source, deadLetter] = await Promise.all([
        getAttributes(options.queueUrl),
        options.deadLetterQueueUrl
          ? getAttributes(options.deadLetterQueueUrl)
          : undefined,
      ]);
      return {
        waiting: approximateCount(source, "ApproximateNumberOfMessages"),
        active: approximateCount(
          source,
          "ApproximateNumberOfMessagesNotVisible",
        ),
        delayed: approximateCount(source, "ApproximateNumberOfMessagesDelayed"),
        failed: approximateCount(deadLetter, "ApproximateNumberOfMessages"),
        // SQS exposes age through CloudWatch rather than queue attributes.
        oldestWaitingAgeSeconds: 0,
      };
    },
    async close() {
      client.destroy();
    },
  };
}

export interface AnalyzeScanWorkerOptions {
  redisUrl: string;
  queueName?: string;
  concurrency?: number;
  onAnalyzeScan: (
    payload: AnalyzeScanJob,
    delivery: {
      jobId: string;
      deliveryAttempt: number;
      maxAttempts: number;
    },
  ) => Promise<void>;
  onError?: (error: Error) => void;
}

export function createAnalyzeScanWorker(options: AnalyzeScanWorkerOptions) {
  const worker = new Worker<AnalyzeScanJob, void, typeof ANALYZE_SCAN_JOB>(
    options.queueName ?? DEFAULT_SCAN_QUEUE_NAME,
    async (job) => {
      if (job.name !== ANALYZE_SCAN_JOB) {
        throw new Error(`Unsupported job name: ${job.name}`);
      }
      await options.onAnalyzeScan(AnalyzeScanJobSchema.parse(job.data), {
        jobId: job.id!,
        deliveryAttempt: job.attemptsMade + 1,
        maxAttempts: job.opts.attempts ?? 1,
      });
    },
    {
      concurrency: options.concurrency ?? 1,
      connection: { url: options.redisUrl, maxRetriesPerRequest: null },
    },
  );

  worker.on("error", (error) => {
    options.onError?.(error);
  });

  return worker;
}

export interface SqsAnalyzeScanWorkerOptions {
  queueUrl: string;
  maxAttempts?: number;
  visibilityTimeoutSeconds?: number;
  waitTimeSeconds?: number;
  onAnalyzeScan: AnalyzeScanWorkerOptions["onAnalyzeScan"];
  onError?: (error: Error) => void;
  client?: SQSClient;
}

export function createSqsAnalyzeScanWorker(
  options: SqsAnalyzeScanWorkerOptions,
) {
  const client = options.client ?? new SQSClient({});
  const abortController = new AbortController();
  let stopping = false;

  const run = (async () => {
    while (!stopping) {
      try {
        const response = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: options.queueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: options.waitTimeSeconds ?? 20,
            VisibilityTimeout: options.visibilityTimeoutSeconds ?? 180,
            MessageSystemAttributeNames: ["ApproximateReceiveCount"],
          }),
          { abortSignal: abortController.signal },
        );
        for (const message of response.Messages ?? []) {
          if (!message.Body || !message.ReceiptHandle) continue;
          const decoded = parseSqsAnalyzeScanMessage(message.Body);
          const job = decoded.job;
          const deliveryAttempt = Math.max(
            1,
            Number(message.Attributes?.ApproximateReceiveCount ?? 1),
          );
          try {
            await options.onAnalyzeScan(job, {
              jobId: decoded.idempotencyKey ?? message.MessageId!,
              deliveryAttempt,
              maxAttempts: options.maxAttempts ?? 5,
            });
            await client.send(
              new DeleteMessageCommand({
                QueueUrl: options.queueUrl,
                ReceiptHandle: message.ReceiptHandle,
              }),
            );
          } catch (error) {
            // Make retryable failures visible immediately. SQS redrive moves
            // repeatedly failing messages to the configured DLQ.
            await client.send(
              new ChangeMessageVisibilityCommand({
                QueueUrl: options.queueUrl,
                ReceiptHandle: message.ReceiptHandle,
                VisibilityTimeout: 0,
              }),
            );
            options.onError?.(
              error instanceof Error ? error : new Error("Unknown SQS error"),
            );
          }
        }
      } catch (error) {
        if (stopping) break;
        options.onError?.(
          error instanceof Error ? error : new Error("Unknown SQS error"),
        );
      }
    }
  })();

  return {
    async close() {
      stopping = true;
      abortController.abort();
      await run;
      client.destroy();
    },
  };
}
