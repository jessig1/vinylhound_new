import { loadQueueWorkerConfig } from "@vinylhound/config";
import { databaseOptionsFromConfig } from "@vinylhound/database";
import { runDatabaseMigrations } from "@vinylhound/database/migrations";

// A just-in-time deploy runs this immediately after activating the
// environment, which can ask a scaled-to-zero Aurora Serverless v2 cluster to
// resume. That resume can take longer than one connection attempt's timeout,
// and migrations run in a single transaction (see runDatabaseMigrations), so
// retrying the whole call after any failure is safe: either nothing
// committed and this is a clean re-attempt, or the same real error recurs on
// every attempt and still fails the deploy once retries are exhausted.
const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 15_000;

const options = databaseOptionsFromConfig(loadQueueWorkerConfig());

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  try {
    await runDatabaseMigrations(options);
    break;
  } catch (error) {
    if (attempt === MAX_ATTEMPTS) {
      throw error;
    }
    console.error("[worker] migration_attempt_failed", {
      attempt,
      maxAttempts: MAX_ATTEMPTS,
      retryInMs: RETRY_DELAY_MS,
      error: error instanceof Error ? error.message : String(error),
    });
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
}
