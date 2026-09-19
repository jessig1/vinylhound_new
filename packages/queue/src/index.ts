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
  ANALYZE_SCAN_JOB_CONTRACT,
  CONFIRMATION_COMPLETED_EVENT,
  CONFIRMATION_COMPLETED_EVENT_CONTRACT,
  SCAN_CONFIRMED_EVENT,
  SCAN_CONFIRMED_EVENT_CONTRACT,
  type AnalyzeScanJob,
  type ConfirmationCompletedEvent,
  type ScanConfirmedEvent,
} from "@vinylhound/contracts";

/**
 * The slice of `EventContract` these generics need. Deliberately structural
 * (not `EventContract<Topic, Schema>` itself): that type's `Schema` generic
 * is constrained to `AnyObjectSchema`, and every concrete contract here has
 * a differently-shaped payload, so naming it directly would force an unsound
 * common instantiation instead of just describing the two methods actually
 * called.
 */
interface ProducibleContract<Payload> {
  readonly topic: string;
  readonly producerSchema: { parse(value: unknown): Payload };
}
interface ConsumableContract<Payload> {
  readonly topic: string;
  readonly consumerSchema: { parse(value: unknown): Payload };
}

export { ANALYZE_SCAN_JOB } from "@vinylhound/contracts";

export const DEFAULT_SCAN_QUEUE_NAME = "vinylhound-scans";
export const DEFAULT_CONFIRMATION_PROCESSING_QUEUE_NAME =
  "vinylhound-confirmation-processing";
export const DEFAULT_CONFIRMATION_COMPLETION_QUEUE_NAME =
  "vinylhound-confirmation-completions";

const defaultTopicJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 10_000 },
};

/**
 * P4.2 Task 3 introduced two more topics with the exact same queue/worker
 * shape `scan.analyze.v1` already had (a BullMQ pair plus an SQS-FIFO-message
 * pair), which made three real, present instances of one pattern -- enough to
 * justify factoring it, unlike speculating about a fourth. `createBullMqScanQueue`/
 * `createAnalyzeScanWorker`/`createSqsScanQueue`/`createSqsAnalyzeScanWorker`
 * below are now thin, behavior-preserving wrappers over these generics; the
 * confirmation queues are built directly on them.
 */
export interface TopicQueue<Payload> {
  enqueue(payload: Payload, idempotencyKey: string): Promise<{ jobId: string }>;
  getOperationalState(): Promise<{
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    oldestWaitingAgeSeconds: number;
  }>;
  close(): Promise<void>;
}

export interface BullMqTopicQueueOptions<Payload> {
  redisUrl: string;
  queueName: string;
  contract: ProducibleContract<Payload>;
  jobOptions?: JobsOptions;
}

export function createBullMqTopicQueue<Payload>(
  options: BullMqTopicQueueOptions<Payload>,
): TopicQueue<Payload> {
  // Every generic type argument through `NameType` is pinned explicitly:
  // left to its default, `NameType` resolves through a conditional
  // (`ExtractNameType<Payload, string>`) that TypeScript cannot collapse
  // while `Payload` is still an unresolved type parameter here, which then
  // rejects a plain `string` job name at `.add()` below.
  const queue = new Queue<Payload, void, string, Payload, void, string>(
    options.queueName,
    { connection: { url: options.redisUrl } },
  );

  return {
    async enqueue(payload, idempotencyKey) {
      const validated = options.contract.producerSchema.parse(payload);
      const job = await queue.add(options.contract.topic, validated, {
        ...defaultTopicJobOptions,
        ...options.jobOptions,
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

export interface BullMqTopicWorkerOptions<Payload> {
  redisUrl: string;
  queueName: string;
  contract: ConsumableContract<Payload>;
  concurrency?: number;
  onMessage: (
    payload: Payload,
    delivery: { jobId: string; deliveryAttempt: number; maxAttempts: number },
  ) => Promise<void>;
  onError?: (error: Error) => void;
}

export function createBullMqTopicWorker<Payload>(
  options: BullMqTopicWorkerOptions<Payload>,
) {
  const worker = new Worker<Payload, void, string>(
    options.queueName,
    async (job) => {
      if (job.name !== options.contract.topic) {
        throw new Error(`Unsupported job name: ${job.name}`);
      }
      // Delivered payloads are read with the consumer schema (ADR-0022): a
      // worker on the previous version must not fail a job the next version
      // enqueued with an optional field it does not know.
      await options.onMessage(options.contract.consumerSchema.parse(job.data), {
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

export interface SqsTopicQueueOptions<Payload> {
  queueUrl: string;
  deadLetterQueueUrl?: string;
  contract: ProducibleContract<Payload>;
  /** The SQS FIFO message group -- callers key it on their own aggregate. */
  groupId?: (payload: Payload) => string;
  client?: SQSClient;
}

export function parseSqsTopicMessage<Payload>(
  body: string,
  contract: ConsumableContract<Payload>,
) {
  const decoded = JSON.parse(body) as {
    idempotencyKey?: unknown;
    job?: unknown;
  };
  return {
    idempotencyKey:
      typeof decoded.idempotencyKey === "string"
        ? decoded.idempotencyKey
        : undefined,
    job: contract.consumerSchema.parse(decoded.job),
  };
}

function approximateCount(
  attributes: Record<string, string> | undefined,
  name: string,
) {
  const value = Number(attributes?.[name] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function createSqsTopicQueue<Payload>(
  options: SqsTopicQueueOptions<Payload>,
): TopicQueue<Payload> {
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
    async enqueue(payload, idempotencyKey) {
      const job = options.contract.producerSchema.parse(payload);
      const fifo = options.queueUrl.endsWith(".fifo");
      await client.send(
        new SendMessageCommand({
          QueueUrl: options.queueUrl,
          MessageBody: JSON.stringify({ idempotencyKey, job }),
          ...(fifo
            ? {
                MessageGroupId: options.groupId?.(job) ?? idempotencyKey,
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

export interface SqsTopicWorkerOptions<Payload> {
  queueUrl: string;
  contract: ConsumableContract<Payload>;
  maxAttempts?: number;
  visibilityTimeoutSeconds?: number;
  waitTimeSeconds?: number;
  onMessage: (
    payload: Payload,
    delivery: { jobId: string; deliveryAttempt: number; maxAttempts: number },
  ) => Promise<void>;
  onError?: (error: Error) => void;
  client?: SQSClient;
}

export function createSqsTopicWorker<Payload>(
  options: SqsTopicWorkerOptions<Payload>,
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
          const decoded = parseSqsTopicMessage(message.Body, options.contract);
          const job = decoded.job;
          const deliveryAttempt = Math.max(
            1,
            Number(message.Attributes?.ApproximateReceiveCount ?? 1),
          );
          try {
            await options.onMessage(job, {
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

// -- scan.analyze.v1 (unchanged external signatures, reimplemented on the
// generics above) --------------------------------------------------------

export interface ScanQueue {
  enqueueAnalyzeScan(
    payload: AnalyzeScanJob,
    idempotencyKey: string,
  ): Promise<{ jobId: string }>;
  getOperationalState(): ReturnType<
    TopicQueue<AnalyzeScanJob>["getOperationalState"]
  >;
  close(): Promise<void>;
}

export interface BullMqScanQueueOptions {
  redisUrl: string;
  queueName?: string;
}

export function createBullMqScanQueue(
  options: BullMqScanQueueOptions,
): ScanQueue {
  const queue = createBullMqTopicQueue<AnalyzeScanJob>({
    redisUrl: options.redisUrl,
    queueName: options.queueName ?? DEFAULT_SCAN_QUEUE_NAME,
    contract: ANALYZE_SCAN_JOB_CONTRACT,
  });
  return {
    enqueueAnalyzeScan: (payload, idempotencyKey) =>
      queue.enqueue(payload, idempotencyKey),
    getOperationalState: () => queue.getOperationalState(),
    close: () => queue.close(),
  };
}

export interface SqsScanQueueOptions {
  queueUrl: string;
  deadLetterQueueUrl?: string;
  client?: SQSClient;
}

export function parseSqsAnalyzeScanMessage(body: string) {
  return parseSqsTopicMessage(body, ANALYZE_SCAN_JOB_CONTRACT);
}

export function createSqsScanQueue(options: SqsScanQueueOptions): ScanQueue {
  const queue = createSqsTopicQueue<AnalyzeScanJob>({
    queueUrl: options.queueUrl,
    deadLetterQueueUrl: options.deadLetterQueueUrl,
    contract: ANALYZE_SCAN_JOB_CONTRACT,
    groupId: (job) => job.scanId,
    client: options.client,
  });
  return {
    enqueueAnalyzeScan: (payload, idempotencyKey) =>
      queue.enqueue(payload, idempotencyKey),
    getOperationalState: () => queue.getOperationalState(),
    close: () => queue.close(),
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
  return createBullMqTopicWorker<AnalyzeScanJob>({
    redisUrl: options.redisUrl,
    queueName: options.queueName ?? DEFAULT_SCAN_QUEUE_NAME,
    contract: ANALYZE_SCAN_JOB_CONTRACT,
    concurrency: options.concurrency,
    onMessage: options.onAnalyzeScan,
    onError: options.onError,
  });
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
  return createSqsTopicWorker<AnalyzeScanJob>({
    queueUrl: options.queueUrl,
    contract: ANALYZE_SCAN_JOB_CONTRACT,
    maxAttempts: options.maxAttempts,
    visibilityTimeoutSeconds: options.visibilityTimeoutSeconds,
    waitTimeSeconds: options.waitTimeSeconds,
    onMessage: options.onAnalyzeScan,
    onError: options.onError,
    client: options.client,
  });
}

// -- scan.confirmed.v1 (P4.2 Task 3, hop 1 -> 2) ---------------------------

export function createConfirmationProcessingQueue(options: {
  redisUrl: string;
  queueName?: string;
}): TopicQueue<ScanConfirmedEvent> {
  return createBullMqTopicQueue<ScanConfirmedEvent>({
    redisUrl: options.redisUrl,
    queueName: options.queueName ?? DEFAULT_CONFIRMATION_PROCESSING_QUEUE_NAME,
    contract: SCAN_CONFIRMED_EVENT_CONTRACT,
  });
}

export function createSqsConfirmationProcessingQueue(options: {
  queueUrl: string;
  deadLetterQueueUrl?: string;
  client?: SQSClient;
}): TopicQueue<ScanConfirmedEvent> {
  return createSqsTopicQueue<ScanConfirmedEvent>({
    queueUrl: options.queueUrl,
    deadLetterQueueUrl: options.deadLetterQueueUrl,
    contract: SCAN_CONFIRMED_EVENT_CONTRACT,
    groupId: (job) => job.scanId,
    client: options.client,
  });
}

export function createConfirmationProcessingWorker(options: {
  redisUrl: string;
  queueName?: string;
  concurrency?: number;
  onScanConfirmed: (
    payload: ScanConfirmedEvent,
    delivery: { jobId: string; deliveryAttempt: number; maxAttempts: number },
  ) => Promise<void>;
  onError?: (error: Error) => void;
}) {
  return createBullMqTopicWorker<ScanConfirmedEvent>({
    redisUrl: options.redisUrl,
    queueName: options.queueName ?? DEFAULT_CONFIRMATION_PROCESSING_QUEUE_NAME,
    contract: SCAN_CONFIRMED_EVENT_CONTRACT,
    concurrency: options.concurrency,
    onMessage: options.onScanConfirmed,
    onError: options.onError,
  });
}

export function createSqsConfirmationProcessingWorker(options: {
  queueUrl: string;
  maxAttempts?: number;
  visibilityTimeoutSeconds?: number;
  waitTimeSeconds?: number;
  onScanConfirmed: (
    payload: ScanConfirmedEvent,
    delivery: { jobId: string; deliveryAttempt: number; maxAttempts: number },
  ) => Promise<void>;
  onError?: (error: Error) => void;
  client?: SQSClient;
}) {
  return createSqsTopicWorker<ScanConfirmedEvent>({
    queueUrl: options.queueUrl,
    contract: SCAN_CONFIRMED_EVENT_CONTRACT,
    maxAttempts: options.maxAttempts,
    visibilityTimeoutSeconds: options.visibilityTimeoutSeconds,
    waitTimeSeconds: options.waitTimeSeconds,
    onMessage: options.onScanConfirmed,
    onError: options.onError,
    client: options.client,
  });
}

// -- confirmation.completed.v1 (P4.2 Task 3, hop 2 -> 3) -------------------

export function createConfirmationCompletionQueue(options: {
  redisUrl: string;
  queueName?: string;
}): TopicQueue<ConfirmationCompletedEvent> {
  return createBullMqTopicQueue<ConfirmationCompletedEvent>({
    redisUrl: options.redisUrl,
    queueName: options.queueName ?? DEFAULT_CONFIRMATION_COMPLETION_QUEUE_NAME,
    contract: CONFIRMATION_COMPLETED_EVENT_CONTRACT,
  });
}

export function createSqsConfirmationCompletionQueue(options: {
  queueUrl: string;
  deadLetterQueueUrl?: string;
  client?: SQSClient;
}): TopicQueue<ConfirmationCompletedEvent> {
  return createSqsTopicQueue<ConfirmationCompletedEvent>({
    queueUrl: options.queueUrl,
    deadLetterQueueUrl: options.deadLetterQueueUrl,
    contract: CONFIRMATION_COMPLETED_EVENT_CONTRACT,
    groupId: (job) => job.scanId,
    client: options.client,
  });
}

export function createConfirmationCompletionWorker(options: {
  redisUrl: string;
  queueName?: string;
  concurrency?: number;
  onConfirmationCompleted: (
    payload: ConfirmationCompletedEvent,
    delivery: { jobId: string; deliveryAttempt: number; maxAttempts: number },
  ) => Promise<void>;
  onError?: (error: Error) => void;
}) {
  return createBullMqTopicWorker<ConfirmationCompletedEvent>({
    redisUrl: options.redisUrl,
    queueName: options.queueName ?? DEFAULT_CONFIRMATION_COMPLETION_QUEUE_NAME,
    contract: CONFIRMATION_COMPLETED_EVENT_CONTRACT,
    concurrency: options.concurrency,
    onMessage: options.onConfirmationCompleted,
    onError: options.onError,
  });
}

export function createSqsConfirmationCompletionWorker(options: {
  queueUrl: string;
  maxAttempts?: number;
  visibilityTimeoutSeconds?: number;
  waitTimeSeconds?: number;
  onConfirmationCompleted: (
    payload: ConfirmationCompletedEvent,
    delivery: { jobId: string; deliveryAttempt: number; maxAttempts: number },
  ) => Promise<void>;
  onError?: (error: Error) => void;
  client?: SQSClient;
}) {
  return createSqsTopicWorker<ConfirmationCompletedEvent>({
    queueUrl: options.queueUrl,
    contract: CONFIRMATION_COMPLETED_EVENT_CONTRACT,
    maxAttempts: options.maxAttempts,
    visibilityTimeoutSeconds: options.visibilityTimeoutSeconds,
    waitTimeSeconds: options.waitTimeSeconds,
    onMessage: options.onConfirmationCompleted,
    onError: options.onError,
    client: options.client,
  });
}

export { SCAN_CONFIRMED_EVENT, CONFIRMATION_COMPLETED_EVENT };
