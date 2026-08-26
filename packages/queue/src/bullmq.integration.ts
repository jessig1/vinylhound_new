import { randomUUID } from "node:crypto";

import { Queue } from "bullmq";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalyzeScanJob } from "@vinylhound/contracts";

import {
  ANALYZE_SCAN_JOB,
  createAnalyzeScanWorker,
  createBullMqScanQueue,
} from "./index.js";

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("REDIS_URL is required for queue integration tests.");
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((close) => close()));
});

describe("BullMQ scan queue", () => {
  it("validates, consumes, and deduplicates a deterministic job ID", async () => {
    const queueName = `vinylhound-integration-${randomUUID()}`;
    const queue = createBullMqScanQueue({ redisUrl, queueName });
    const administrationQueue = new Queue(queueName, {
      connection: { url: redisUrl },
    });
    let handledCount = 0;
    let resolveHandled!: (payload: AnalyzeScanJob) => void;
    const handled = new Promise<AnalyzeScanJob>((resolve) => {
      resolveHandled = resolve;
    });
    const worker = createAnalyzeScanWorker({
      redisUrl,
      queueName,
      onAnalyzeScan: async (payload) => {
        handledCount += 1;
        resolveHandled(payload);
      },
    });
    cleanup.push(async () => {
      await worker.close();
      await queue.close();
      await administrationQueue.obliterate({ force: true });
      await administrationQueue.close();
    });

    await worker.waitUntilReady();
    const payload: AnalyzeScanJob = {
      jobVersion: 1,
      scanId: randomUUID(),
      userId: randomUUID(),
      attemptNumber: 1,
      imageIds: [randomUUID()],
      requestedAt: new Date().toISOString(),
    };
    const jobId = `scan-${payload.scanId}-attempt-1`;

    const first = await queue.enqueueAnalyzeScan(payload, jobId);
    const processed = await handled;
    const replay = await queue.enqueueAnalyzeScan(payload, jobId);

    expect(first.jobId).toBe(jobId);
    expect(replay.jobId).toBe(jobId);
    expect(processed).toEqual(payload);
    expect(handledCount).toBe(1);
    expect(await administrationQueue.getJob(jobId)).toMatchObject({
      name: ANALYZE_SCAN_JOB,
    });
  });
});
