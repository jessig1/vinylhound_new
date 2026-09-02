import { Queue, Worker, type JobsOptions } from "bullmq";

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
  hasJob(jobId: string): Promise<boolean>;
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
    async hasJob(jobId) {
      return (await queue.getJob(jobId)) !== undefined;
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
