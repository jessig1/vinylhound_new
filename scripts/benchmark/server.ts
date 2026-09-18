import path from "node:path";
import type { ChildProcess } from "node:child_process";

import { BENCH_NEXT_DIST_DIR, BENCH_PORT, repoRoot } from "./env.ts";
import {
  runSync,
  spawnManaged,
  stopProcess,
  waitForHttpOk,
} from "./process-utils.ts";

export interface BenchStack {
  web: ChildProcess;
  worker: ChildProcess;
  stop(): void;
}

/**
 * Builds and starts the real production standalone server (the same
 * `next build` + prepare-standalone.mjs + `node server.js` path
 * apps/web/playwright.config.ts uses for e2e) plus the synthetic-identifier
 * worker at apps/worker/src/e2e-worker.ts, both pointed at the isolated
 * benchmark database/queue/port from env.ts. A dedicated NEXT_DIST_DIR keeps
 * this build from colliding with a developer's own `.next` or the e2e
 * suite's `.next-e2e`.
 */
export async function startBenchStack(
  env: Record<string, string>,
): Promise<BenchStack> {
  const webDir = path.join(repoRoot, "apps/web");
  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    NEXT_DIST_DIR: BENCH_NEXT_DIST_DIR,
    // Playwright's own e2e config pins this the same way: a plain build
    // would otherwise inherit whatever NODE_ENV this script runs under.
    NODE_ENV: "production" as const,
  };

  console.info("[benchmark] building the web app (production, standalone)…");
  runSync("npm", ["run", "build"], { cwd: webDir, env: buildEnv });
  runSync("node", ["scripts/prepare-standalone.mjs"], {
    cwd: webDir,
    env: buildEnv,
  });

  console.info("[benchmark] starting the synthetic-identifier worker…");
  const worker = await spawnManaged(
    process.execPath,
    [
      path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"),
      path.join(repoRoot, "apps/worker/src/e2e-worker.ts"),
    ],
    { cwd: repoRoot, env: { ...process.env, ...env } },
  );

  console.info("[benchmark] starting the standalone web server…");
  const web = await spawnManaged(
    "node",
    [path.join(webDir, BENCH_NEXT_DIST_DIR, "standalone/apps/web/server.js")],
    {
      cwd: webDir,
      env: { ...buildEnv, PORT: String(BENCH_PORT) },
    },
  );

  await waitForHttpOk(`http://localhost:${BENCH_PORT}/api/readyz`);
  console.info("[benchmark] stack ready.");

  return {
    web,
    worker,
    stop() {
      stopProcess(web);
      stopProcess(worker);
    },
  };
}
