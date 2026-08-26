import path from "node:path";

import { loadEnvConfig } from "@next/env";

export const E2E_PORT = 3100;
export const E2E_DATABASE_NAME = "vinylhound_e2e";
export const repoRoot = path.resolve(__dirname, "../../..");

/**
 * Environment overrides that isolate the e2e run from the development stack:
 * a dedicated database, a dedicated queue name, a dedicated port, and an
 * explicitly empty OpenAI key so nothing billable can run.
 */
export function buildE2eEnv(): Record<string, string> {
  loadEnvConfig(repoRoot);
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
  };
}

/** Connection string for the development database used to create the e2e one. */
export function adminDatabaseUrl(): string {
  loadEnvConfig(repoRoot);
  return (
    process.env.DATABASE_URL ??
    "postgresql://vinylhound:vinylhound@localhost:5432/vinylhound"
  );
}
