import { loadQueueWorkerConfig } from "@vinylhound/config";
import {
  createDatabase,
  databaseOptionsFromConfig,
  getOperationalDrainState,
  listRepublishableAnalysisJobs,
} from "@vinylhound/database";
import { createBullMqScanQueue } from "@vinylhound/queue";

const command = process.argv[2];
if (command !== "drain-check" && command !== "reconcile-queue") {
  throw new Error("Usage: ops <drain-check|reconcile-queue>");
}

const config = loadQueueWorkerConfig();
const database = createDatabase(databaseOptionsFromConfig(config));
const queue = createBullMqScanQueue({
  redisUrl: config.REDIS_URL,
  queueName: config.SCAN_QUEUE_NAME,
});

try {
  if (command === "drain-check") {
    const databaseState = await getOperationalDrainState(database.db);
    const queueState = await queue.getOperationalState();
    const drained =
      databaseState.activeScans === 0 &&
      databaseState.pendingOutbox === 0 &&
      queueState.waiting === 0 &&
      queueState.active === 0 &&
      queueState.delayed === 0;
    console.info(
      JSON.stringify({
        event: "drain_check",
        drained,
        ...databaseState,
        ...queueState,
      }),
    );
    if (!drained) process.exitCode = 2;
  } else {
    const candidates = await listRepublishableAnalysisJobs(database.db);
    let republished = 0;
    for (const candidate of candidates) {
      if (await queue.hasJob(candidate.idempotencyKey)) continue;
      await queue.enqueueAnalyzeScan(candidate.job, candidate.idempotencyKey);
      republished += 1;
    }
    console.info(
      JSON.stringify({
        event: "queue_reconciliation",
        candidates: candidates.length,
        republished,
      }),
    );
  }
} finally {
  await Promise.allSettled([queue.close(), database.close()]);
}
