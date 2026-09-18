import { spawnSync } from "node:child_process";

import { Client } from "pg";

import { adminDatabaseUrl, BENCH_DATABASE_NAME, repoRoot } from "./env.ts";

/** Creates the dedicated concurrency-comparison database if missing. */
export async function ensureBenchDatabase(): Promise<void> {
  const admin = new Client({ connectionString: adminDatabaseUrl() });
  await admin.connect();
  try {
    const existing = await admin.query(
      "select 1 from pg_database where datname = $1",
      [BENCH_DATABASE_NAME],
    );
    if (existing.rowCount === 0) {
      await admin.query(`create database ${BENCH_DATABASE_NAME}`);
    }
  } finally {
    await admin.end();
  }
}

/** Applies pending migrations to the dedicated database. */
export function migrateBenchDatabase(env: Record<string, string>): void {
  const result = spawnSync(
    "npm run db:migrate --workspace @vinylhound/database",
    {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      shell: true,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `concurrency-comparison database migration failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
}

/**
 * Clears prior data between legs of the comparison (one leg per
 * mode/worker-count combination). The database is dedicated to this tool
 * and holds nothing else, so a full truncate is safe and cheaper than
 * deleting by identity, and — critically for the live-mode cost readout —
 * leaves each leg's `scan_attempts` rows uncontaminated by any other leg's.
 */
export async function resetBenchData(
  env: Record<string, string>,
): Promise<void> {
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("truncate table users, albums cascade");
  } finally {
    await client.end();
  }
}
