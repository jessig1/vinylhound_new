import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

const user = process.env.POSTGRES_USER || "vinylhound";
const database = process.env.POSTGRES_DB || "vinylhound";
const restoreDatabase = "vinylhound_restore_verification";
const tempDirectory = join(process.cwd(), "tmp");
const dumpPath = join(tempDirectory, `postgres-restore-${Date.now()}.sql`);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(child);
      else
        reject(
          new Error(`${command} ${args.join(" ")} failed: ${stderr.trim()}`),
        );
    });
  });
}

async function main() {
  mkdirSync(tempDirectory, { recursive: true });
  console.info(
    "Creating a logical PostgreSQL backup from the local compose service…",
  );
  const dump = spawn(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "pg_dump",
      "-U",
      user,
      "--format=p",
      database,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  await pipeline(dump.stdout, createWriteStream(dumpPath));
  await new Promise((resolve, reject) =>
    dump.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error("pg_dump failed.")),
    ),
  );

  try {
    await run("docker", [
      "compose",
      "exec",
      "-T",
      "postgres",
      "dropdb",
      "-U",
      user,
      "--if-exists",
      restoreDatabase,
    ]);
    await run("docker", [
      "compose",
      "exec",
      "-T",
      "postgres",
      "createdb",
      "-U",
      user,
      restoreDatabase,
    ]);
    const restore = spawn(
      "docker",
      [
        "compose",
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        user,
        "-v",
        "ON_ERROR_STOP=1",
        "-d",
        restoreDatabase,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const restoreInput = await import("node:fs").then(({ createReadStream }) =>
      createReadStream(dumpPath),
    );
    await pipeline(restoreInput, restore.stdin);
    await new Promise((resolve, reject) =>
      restore.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error("psql restore failed.")),
      ),
    );
    await run("docker", [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      user,
      "-v",
      "ON_ERROR_STOP=1",
      "-d",
      restoreDatabase,
      "-c",
      "select count(*) from vinylhound_migrations;",
    ]);
    console.info("Restore verification passed.");
  } finally {
    await run("docker", [
      "compose",
      "exec",
      "-T",
      "postgres",
      "dropdb",
      "-U",
      user,
      "--if-exists",
      restoreDatabase,
    ]).catch(() => {});
    if (existsSync(dumpPath)) rmSync(dumpPath);
  }
}

await main();
