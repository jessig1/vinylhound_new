import { loadQueueWorkerConfig } from "@vinylhound/config";
import { databaseOptionsFromConfig } from "@vinylhound/database";
import { rollbackDatabaseMigrations } from "@vinylhound/database/migrations";

// Deliberately no retry loop, unlike migrate.ts's just-in-time-activation
// retries: a rollback is a rare, operator-invoked action against a database
// already accepting connections, not something to silently re-attempt after
// a failure that might itself be the reason to stop and look.
const countArg = process.argv[2];
const count = countArg === undefined ? 1 : Number(countArg);
if (!Number.isInteger(count) || count < 1) {
  throw new Error(
    "Usage: rollback <count> -- a positive integer number of migrations to reverse (defaults to 1).",
  );
}

const config = loadQueueWorkerConfig();
const options = databaseOptionsFromConfig(config);

await rollbackDatabaseMigrations(options, count);
console.info(JSON.stringify({ event: "migrations_rolled_back", count }));
