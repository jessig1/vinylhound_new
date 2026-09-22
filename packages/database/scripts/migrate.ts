import { databaseOptionsFromConfig } from "../src/database.ts";
import { runDatabaseMigrations } from "../src/migrations.ts";

/**
 * `npm run db:migrate`'s actual entry point (P4.2 Task 7, ADR-0030). Used to
 * invoke `node-pg-migrate`'s CLI directly, which only ever read
 * `DATABASE_URL` -- migration 021's `GRANT ... TO vinylhound_scan_app`/
 * `vinylhound_core_app` statements need those two roles to already exist,
 * which only `ensureDatabaseRoles` (`../src/roles.ts`, invoked here through
 * `runDatabaseMigrations`) can create, and only `runDatabaseMigrations`
 * itself invokes `node-pg-migrate` afterward. Every migration path in this
 * repo (local dev, staging's `run-worker-command.sh migrate`, production's
 * Kubernetes Job) now goes through this same function.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required to run migrations.`);
  }
  return value;
}

const options = databaseOptionsFromConfig({
  DATABASE_URL: required("DATABASE_URL"),
  DATABASE_MAX_CONNECTIONS: Number(process.env.DATABASE_MAX_CONNECTIONS ?? 5),
  DATABASE_CONNECT_TIMEOUT_MS: Number(
    process.env.DATABASE_CONNECT_TIMEOUT_MS ?? 30_000,
  ),
  DATABASE_SSL_MODE:
    (process.env.DATABASE_SSL_MODE as "disable" | "require" | "verify-full") ??
    "disable",
  DATABASE_SSL_CA_BASE64: process.env.DATABASE_SSL_CA_BASE64,
});

await runDatabaseMigrations(options, {
  scanUrl: required("SCAN_DATABASE_URL"),
  coreUrl: required("CORE_DATABASE_URL"),
});
console.info("[db] migrations applied");
