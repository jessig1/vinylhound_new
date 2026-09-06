import { loadQueueWorkerConfig } from "@vinylhound/config";
import { databaseOptionsFromConfig } from "@vinylhound/database";
import { runDatabaseMigrations } from "@vinylhound/database/migrations";

const config = loadQueueWorkerConfig();
await runDatabaseMigrations(databaseOptionsFromConfig(config));
