import { spawnSync } from "node:child_process";

import { Client } from "pg";

import { adminDatabaseUrl, BENCH_DATABASE_NAME, repoRoot } from "./env.ts";

/** Creates the dedicated benchmark database if it does not already exist. */
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

/** Applies pending migrations to the benchmark database. */
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
      `benchmark database migration failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
}

/**
 * Clears prior benchmark data between timed runs, the same way
 * apps/web/e2e/global-setup.ts resets the e2e database. The benchmark
 * database is dedicated to this tool and holds nothing else, so a full
 * truncate is safe and cheaper than deleting by identity; it also stops
 * quota/active-scan state from one run leaking into the next.
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
