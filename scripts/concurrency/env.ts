import path from "node:path";

// A default import — see scripts/benchmark/env.ts for why: @next/env's CJS
// build fails named-export resolution under plain Node ESM (how tsx runs
// this script).
import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;

export type WorkerMode = "stub" | "live";

// A dedicated port/database/queue/dist-dir, isolated from both the
// developer's own stack and scripts/benchmark's (which already uses 3200 /
// vinylhound_e2e_bench / .next-bench) so the two tools can be run without
// colliding.
export const BENCH_PORT = 3300;
export const BENCH_DATABASE_NAME = "vinylhound_e2e_concurrency";
export const BENCH_QUEUE_NAME = "vinylhound-scans-concurrency";
export const BENCH_NEXT_DIST_DIR = ".next-concurrency";
export const repoRoot = path.resolve(import.meta.dirname, "../..");

/**
 * `mode: "stub"` isolates the run from OpenAI the same way
 * scripts/benchmark/env.ts does (an explicitly empty key, even though
 * apps/worker/src/e2e-worker.ts structurally never reads it). `mode: "live"`
 * does the opposite on purpose: it passes through whatever real
 * `OPENAI_API_KEY` (and `OPENAI_VISION_MODEL`/`OPENAI_IMAGE_DETAIL`/etc.)
 * the caller's own `.env` already has, so a live run measures this
 * project's actual configured model — never inventing or hardcoding one —
 * and refuses immediately with a clear message if no real key is present,
 * before anything is built or spawned.
 */
export function buildEnv(mode: WorkerMode): Record<string, string> {
  loadEnvConfig(repoRoot, true, console, true);
  const url = new URL(
    process.env.DATABASE_URL ??
      "postgresql://vinylhound:vinylhound@localhost:5432/vinylhound",
  );
  url.pathname = `/${BENCH_DATABASE_NAME}`;
  const base: Record<string, string> = {
    DATABASE_URL: url.toString(),
    SCAN_QUEUE_NAME: BENCH_QUEUE_NAME,
    APP_URL: `http://localhost:${BENCH_PORT}`,
    AUTH_MODE: "development",
    NEXT_PUBLIC_AUTH_MODE: "development",
    DEVELOPMENT_BENCH_USER_HEADER_ENABLED: "true",
  };
  if (mode === "stub") {
    return { ...base, OPENAI_API_KEY: "" };
  }
  const realKey = process.env.OPENAI_API_KEY;
  if (!realKey) {
    throw new Error(
      "mode=live needs a real OPENAI_API_KEY in .env — refusing to start rather than silently falling back to the stub. See scripts/concurrency/README.md.",
    );
  }
  // Deliberately does not override OPENAI_VISION_MODEL/OPENAI_IMAGE_DETAIL/
  // OPENAI_TIMEOUT_MS: the worker process inherits them from process.env via
  // `{ ...process.env, ...env }` at the spawn site, so a live run measures
  // whatever this project is actually configured to call, not a value
  // chosen by this script.
  return { ...base, OPENAI_API_KEY: realKey };
}

/** Connection string for the admin database used to create the bench one. */
export function adminDatabaseUrl(): string {
  loadEnvConfig(repoRoot, true, console, true);
  return (
    process.env.DATABASE_URL ??
    "postgresql://vinylhound:vinylhound@localhost:5432/vinylhound"
  );
}
