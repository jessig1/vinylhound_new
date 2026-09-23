import { loadQueueWorkerConfig } from "@vinylhound/config";
import { databaseOptionsFromConfig } from "@vinylhound/database";
import { validateScanCoreForeignKeys } from "@vinylhound/database/migrations";

const config = loadQueueWorkerConfig();
const options = databaseOptionsFromConfig(config);

const results = await validateScanCoreForeignKeys(options);
const failed = results.filter((result) => !result.valid);
console.info(JSON.stringify({ event: "fk_validation", results }));
if (failed.length > 0) {
  process.exitCode = 2;
}
