import path from "node:path";

import { loadEnvConfig } from "@next/env";

export const E2E_PORT = 3100;
export const E2E_DATABASE_NAME = "vinylhound_e2e";
export const repoRoot = path.resolve(__dirname, "../../..");

/**
 * Environment overrides that isolate the e2e run from the development stack:
 * a dedicated database, a dedicated queue name, a dedicated port, an
 * explicitly empty OpenAI key so nothing billable can run, and a forced
 * development AUTH_MODE so the suite never depends on whatever the local
 * .env's AUTH_MODE happens to be set to (ADR-0013 requires e2e/CI to run
 * without real Clerk credentials) — the scan-flow tests navigate straight
 * to protected routes with no sign-in step, so a stray
 * AUTH_MODE=production in .env would otherwise redirect every test to
 * /sign-in and fail the whole suite.
 */
function e2eDatabaseUrl(envVar: string, fallback: string): string {
  const url = new URL(process.env[envVar] ?? fallback);
  url.pathname = `/${E2E_DATABASE_NAME}`;
  return url.toString();
}

export function buildE2eEnv(): Record<string, string> {
  loadEnvConfig(repoRoot, true, console, true);
  return {
    DATABASE_URL: e2eDatabaseUrl(
      "DATABASE_URL",
      "postgresql://vinylhound:vinylhound@localhost:5432/vinylhound",
    ),
    // P4.2 Task 7 (ADR-0030): the e2e worker's own DATABASE_URL guard
    // (apps/worker/src/e2e-worker.ts) only refuses to start against a
    // non-e2e database; every actual query runs through these two role
    // credentials instead, isolated to the same e2e database by name.
    SCAN_DATABASE_URL: e2eDatabaseUrl(
      "SCAN_DATABASE_URL",
      "postgresql://vinylhound_scan_app:vinylhound_scan@localhost:5432/vinylhound",
    ),
    CORE_DATABASE_URL: e2eDatabaseUrl(
      "CORE_DATABASE_URL",
      "postgresql://vinylhound_core_app:vinylhound_core@localhost:5432/vinylhound",
    ),
    SCAN_QUEUE_NAME: "vinylhound-scans-e2e",
    // P4.2 Task 3: same isolation as SCAN_QUEUE_NAME above, so the e2e
    // worker's confirmation pipeline never shares a BullMQ queue with a
    // concurrently running `npm run dev:worker` on the same Redis.
    CONFIRMATION_PROCESSING_QUEUE_NAME:
      "vinylhound-confirmation-processing-e2e",
    CONFIRMATION_COMPLETION_QUEUE_NAME:
      "vinylhound-confirmation-completion-e2e",
    APP_URL: `http://localhost:${E2E_PORT}`,
    OPENAI_API_KEY: "",
    AUTH_MODE: "development",
    NEXT_PUBLIC_AUTH_MODE: "development",
  };
}

/** Connection string for the development database used to create the e2e one. */
export function adminDatabaseUrl(): string {
  loadEnvConfig(repoRoot, true, console, true);
  return (
    process.env.DATABASE_URL ??
    "postgresql://vinylhound:vinylhound@localhost:5432/vinylhound"
  );
}
