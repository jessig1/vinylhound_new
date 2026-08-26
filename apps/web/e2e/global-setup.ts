import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";

import { Client } from "pg";

import {
  adminDatabaseUrl,
  buildE2eEnv,
  E2E_DATABASE_NAME,
  repoRoot,
} from "./env";

export default async function globalSetup() {
  const e2eEnv = buildE2eEnv();
  const mergedEnv = { ...process.env, ...e2eEnv };

  const admin = new Client({ connectionString: adminDatabaseUrl() });
  await admin.connect();
  try {
    const existing = await admin.query(
      "select 1 from pg_database where datname = $1",
      [E2E_DATABASE_NAME],
    );
    if (existing.rowCount === 0) {
      await admin.query(`create database ${E2E_DATABASE_NAME}`);
    }
  } finally {
    await admin.end();
  }

  const migrate = spawnSync(
    "npm run db:migrate --workspace @vinylhound/database",
    {
      cwd: repoRoot,
      env: mergedEnv,
      shell: true,
      encoding: "utf8",
    },
  );
  if (migrate.status !== 0) {
    throw new Error(
      `e2e database migration failed:\n${migrate.stdout}\n${migrate.stderr}`,
    );
  }

  const database = new Client({ connectionString: e2eEnv.DATABASE_URL });
  await database.connect();
  try {
    await database.query("truncate table users, albums cascade");
  } finally {
    await database.end();
  }

  const worker = spawn(
    process.execPath,
    [
      path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"),
      path.join(repoRoot, "apps/worker/src/e2e-worker.ts"),
    ],
    { env: mergedEnv, stdio: ["ignore", "inherit", "inherit"] },
  );
  const startupFailure = new Promise<never>((_, reject) => {
    worker.once("exit", (code) =>
      reject(new Error(`e2e worker exited during startup with code ${code}`)),
    );
  });
  await Promise.race([
    startupFailure,
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  worker.removeAllListeners("exit");

  return async () => {
    stopWorker(worker);
  };
}

function stopWorker(worker: ChildProcess) {
  if (worker.pid === undefined || worker.exitCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(worker.pid), "/T", "/F"]);
  } else {
    worker.kill("SIGTERM");
  }
}
