import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";

import type { DatabaseOptions } from "./database.ts";
import { ensureDatabaseRoles } from "./roles.ts";

export async function runDatabaseMigrations(
  options: DatabaseOptions,
  roles?: { scanUrl: string; coreUrl: string },
) {
  if (roles) {
    // P4.2 Task 7 (ADR-0030): must exist before migration 021's GRANTs run,
    // and a plain .sql migration file cannot read the environment to learn
    // these passwords -- see roles.ts's own doc comment.
    await ensureDatabaseRoles(options, roles);
  }

  return runner({
    databaseUrl: {
      connectionString: options.connectionString,
      connectionTimeoutMillis: options.connectionTimeoutMillis,
      ssl: options.ssl,
    },
    direction: "up",
    dir: fileURLToPath(new URL("../migrations", import.meta.url)),
    migrationsTable: "vinylhound_migrations",
    singleTransaction: true,
  });
}
