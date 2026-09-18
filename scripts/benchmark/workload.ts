import { createBatch, newBenchUserId, runScanPipeline } from "./client.ts";
import type { ScanPipelineResult } from "./client.ts";
import type { ImageFixture } from "./fixture.ts";

export interface WorkloadConfig {
  users: number;
  batchesPerUser: number;
  scansPerBatch: number;
  concurrency: number;
}

export interface WorkloadOutcome {
  config: WorkloadConfig;
  totalScans: number;
  wallClockMs: number;
  results: ScanPipelineResult[];
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function lane() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, lane),
  );
  return results;
}

function shuffle<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Builds `users` distinct synthetic userIds, `batchesPerUser` real batches
 * each, and `scansPerBatch` scan pipelines per batch — deliberately never
 * one user or one batch alone, per the P3.5 plan review's finding that a
 * single-user/single-batch load test measures pg_advisory_xact_lock and the
 * batch row lock rather than real throughput. Batch/scan/user pairings are
 * shuffled before dispatch so the bounded worker pool interleaves distinct
 * lock targets instead of draining one batch to completion before starting
 * the next.
 */
export async function runWorkload(
  baseUrl: string,
  fixture: ImageFixture,
  config: WorkloadConfig,
): Promise<WorkloadOutcome> {
  const userIds = Array.from({ length: config.users }, () => newBenchUserId());

  const batchTargets = userIds.flatMap((userId) =>
    Array.from({ length: config.batchesPerUser }, () => userId),
  );
  const batchIds = await runWithConcurrency(
    batchTargets,
    config.concurrency,
    (userId) => createBatch(baseUrl, userId),
  );
  const userBatchPairs = batchTargets.map((userId, index) => ({
    userId,
    batchId: batchIds[index],
  }));

  const scanTasks = shuffle(
    userBatchPairs.flatMap((pair) =>
      Array.from({ length: config.scansPerBatch }, () => pair),
    ),
  );

  const startedAt = performance.now();
  const results = await runWithConcurrency(
    scanTasks,
    config.concurrency,
    (task) => runScanPipeline(baseUrl, task.userId, task.batchId, fixture),
  );
  const wallClockMs = performance.now() - startedAt;

  return { config, totalScans: scanTasks.length, wallClockMs, results };
}
