import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import { Client } from "pg";

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

/**
 * The eight FKs 022's down migration re-adds `NOT VALID` (docs/OPERATIONS.md's
 * "Scan/core schema and role rollback" runbook, step 2) — a row orphaned
 * while they were absent must not make the rollback itself fail, but each
 * constraint still needs an explicit `VALIDATE CONSTRAINT` pass once any
 * such row has been reconciled. `docs/OPERATIONS.md` had flagged this as
 * "not yet built" for a deployed environment (no local checkout, no ad hoc
 * SQL client) — this reuses the same admin connection
 * rollbackDatabaseMigrations/runDatabaseMigrations already use, not a
 * scan-/core-scoped app role, since VALIDATE CONSTRAINT needs table
 * ownership. Runs each constraint independently and reports per-constraint
 * results rather than failing on the first one, matching the runbook's own
 * "reconcile any row that would fail it" framing -- a caller needs to know
 * exactly which constraints still have real violations, not just that
 * validation as a whole didn't complete.
 */
const SCAN_CORE_FOREIGN_KEYS = [
  { table: "scan.scans", constraint: "scans_user_id_fkey" },
  { table: "scan.batches", constraint: "batches_user_id_fkey" },
  {
    table: "scan.scan_confirmations",
    constraint: "scan_confirmations_user_id_fkey",
  },
  {
    table: "core.library_items",
    constraint: "library_items_confirmed_from_scan_id_fkey",
  },
  {
    table: "core.library_copies",
    constraint: "library_copies_confirmed_from_scan_id_fkey",
  },
  {
    table: "scan.scan_confirmations",
    constraint: "scan_confirmations_release_id_fkey",
  },
  {
    table: "scan.scan_confirmations",
    constraint: "scan_confirmations_library_item_id_fkey",
  },
  {
    table: "scan.scan_confirmations",
    constraint: "scan_confirmations_copy_id_fkey",
  },
] as const;

export interface ForeignKeyValidationResult {
  table: string;
  constraint: string;
  valid: boolean;
  error?: string;
}

export async function validateScanCoreForeignKeys(
  options: DatabaseOptions,
): Promise<ForeignKeyValidationResult[]> {
  const client = new Client({
    connectionString: options.connectionString,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
    ssl: options.ssl,
  });
  await client.connect();
  try {
    const results: ForeignKeyValidationResult[] = [];
    for (const { table, constraint } of SCAN_CORE_FOREIGN_KEYS) {
      try {
        await client.query(
          `ALTER TABLE ${table} VALIDATE CONSTRAINT ${constraint}`,
        );
        results.push({ table, constraint, valid: true });
      } catch (error) {
        results.push({
          table,
          constraint,
          valid: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  } finally {
    await client.end();
  }
}
