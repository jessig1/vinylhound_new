import path from "node:path";
import type { ChildProcess } from "node:child_process";

import {
  runSync,
  spawnManaged,
  stopProcess,
  waitForHttpOk,
} from "../benchmark/process-utils.ts";
import { BENCH_NEXT_DIST_DIR, BENCH_PORT, repoRoot } from "./env.ts";

export interface WebHandle {
  process: ChildProcess;
  stop(): void;
}

/**
 * Builds and starts the real production standalone web server, the same
 * build scripts/benchmark/server.ts and apps/web/playwright.config.ts use
 * for e2e — but not a worker, unlike that helper: this tool starts a
 * variable number of worker processes per leg (see workers.ts), so worker
 * lifecycle is deliberately kept separate from the web server's.
 */
export async function startWeb(
  env: Record<string, string>,
): Promise<WebHandle> {
  const webDir = path.join(repoRoot, "apps/web");
  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    NEXT_DIST_DIR: BENCH_NEXT_DIST_DIR,
    NODE_ENV: "production" as const,
  };

  console.info("[concurrency] building the web app (production, standalone)…");
  runSync("npm", ["run", "build"], { cwd: webDir, env: buildEnv });
  runSync("node", ["scripts/prepare-standalone.mjs"], {
    cwd: webDir,
    env: buildEnv,
  });

  console.info("[concurrency] starting the standalone web server…");
  const web = await spawnManaged(
    "node",
    [path.join(webDir, BENCH_NEXT_DIST_DIR, "standalone/apps/web/server.js")],
    { cwd: webDir, env: { ...buildEnv, PORT: String(BENCH_PORT) } },
  );
  await waitForHttpOk(`http://localhost:${BENCH_PORT}/api/readyz`);
  console.info("[concurrency] web ready.");

  return { process: web, stop: () => stopProcess(web) };
}
