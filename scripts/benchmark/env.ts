import path from "node:path";

// A default import, not `{ loadEnvConfig }`: this script runs under plain
// Node ESM (via tsx), where the named-export static analysis Next's own
// tooling relies on (Playwright's bundler, in apps/web/e2e/env.ts) does not
// apply to @next/env's CJS build and fails at import time.
import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;

// Isolates the benchmark from the development stack the same way
// apps/web/e2e/env.ts isolates Playwright: a dedicated database, queue name,
// and port, plus an explicitly empty OpenAI key so nothing billable can run.
// The database name deliberately contains "vinylhound_e2e" so it satisfies
// apps/worker/src/e2e-worker.ts's own safety guard, which refuses to start
// against anything else — the benchmark reuses that worker unmodified with
// its synthetic (non-OpenAI) identifier, it does not fork it.
export const BENCH_PORT = 3200;
export const BENCH_DATABASE_NAME = "vinylhound_e2e_bench";
export const BENCH_QUEUE_NAME = "vinylhound-scans-bench";
export const BENCH_NEXT_DIST_DIR = ".next-bench";
export const repoRoot = path.resolve(import.meta.dirname, "../..");

export function buildBenchEnv(): Record<string, string> {
  loadEnvConfig(repoRoot, true, console, true);
  const url = new URL(
    process.env.DATABASE_URL ??
      "postgresql://vinylhound:vinylhound@localhost:5432/vinylhound",
  );
  url.pathname = `/${BENCH_DATABASE_NAME}`;
  return {
    DATABASE_URL: url.toString(),
    SCAN_QUEUE_NAME: BENCH_QUEUE_NAME,
    APP_URL: `http://localhost:${BENCH_PORT}`,
    OPENAI_API_KEY: "",
    AUTH_MODE: "development",
    NEXT_PUBLIC_AUTH_MODE: "development",
    DEVELOPMENT_BENCH_USER_HEADER_ENABLED: "true",
  };
}

/** Connection string for the admin database used to create the bench one. */
export function adminDatabaseUrl(): string {
  loadEnvConfig(repoRoot, true, console, true);
  return (
    process.env.DATABASE_URL ??
    "postgresql://vinylhound:vinylhound@localhost:5432/vinylhound"
  );
}
