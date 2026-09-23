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

/**
 * P4.3 Task 4: the deployed worker image had no way to run a down migration
 * at all (only `runDatabaseMigrations`'s `direction: "up"`, above) --
 * `docs/OPERATIONS.md`'s "Scan/core schema and role rollback" runbook
 * assumed a local dev checkout with `npx node-pg-migrate` available, which
 * the production image deliberately strips (no npm/npx, to shrink its
 * vulnerability surface). Reuses `runner()`'s own SSL-aware
 * `options.ssl`/`connectionString` the same way `runDatabaseMigrations`
 * does, rather than shelling out to the CLI and re-deriving TLS setup by
 * hand.
 */
export async function rollbackDatabaseMigrations(
  options: DatabaseOptions,
  count: number,
) {
  return runner({
    databaseUrl: {
      connectionString: options.connectionString,
      connectionTimeoutMillis: options.connectionTimeoutMillis,
      ssl: options.ssl,
    },
    direction: "down",
    count,
    dir: fileURLToPath(new URL("../migrations", import.meta.url)),
    migrationsTable: "vinylhound_migrations",
    singleTransaction: true,
  });
}
