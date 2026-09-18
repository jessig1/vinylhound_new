import path from "node:path";

// A default import, not `{ loadEnvConfig }` — see scripts/benchmark/env.ts
// for why: @next/env's CJS build fails named-export resolution under plain
// Node ESM (how tsx runs this script).
import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;

export const repoRoot = path.resolve(import.meta.dirname, "../..");

/**
 * Unlike scripts/benchmark/env.ts, this does not redirect to an isolated
 * database — Task 3 reconciles real persisted attempts, so it deliberately
 * reads whatever `DATABASE_URL` the caller's `.env` points at (the
 * developer's own local database by default). Point it at another
 * environment's database (e.g. via a bastion/port-forward) to reconcile that
 * environment instead; nothing here writes.
 */
export function databaseUrl(): string {
  loadEnvConfig(repoRoot, true, console, true);
  return (
    process.env.DATABASE_URL ??
    "postgresql://vinylhound:vinylhound@localhost:5432/vinylhound"
  );
}
