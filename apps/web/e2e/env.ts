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
export function buildE2eEnv(): Record<string, string> {
  loadEnvConfig(repoRoot, true, console, true);
  const url = new URL(
    process.env.DATABASE_URL ??
      "postgresql://vinylhound:vinylhound@localhost:5432/vinylhound",
  );
  url.pathname = `/${E2E_DATABASE_NAME}`;
  return {
    DATABASE_URL: url.toString(),
    SCAN_QUEUE_NAME: "vinylhound-scans-e2e",
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
