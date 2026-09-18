import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export function stopProcess(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  } else {
    child.kill("SIGTERM");
  }
}

export function runSync(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: true,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status}`,
    );
  }
}

/** Spawns a long-running child process, failing fast if it exits during startup. */
export async function spawnManaged(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<ChildProcess> {
  // No shell: both call sites invoke a real executable (node.exe /
  // process.execPath) with an argv array, which spawn() runs directly on
  // every platform without one. A shell is only needed to resolve a .cmd
  // shim like npm on Windows (see runSync above), and forcing one here
  // breaks on a node.exe path containing spaces (e.g. "C:\Program Files\...").
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "inherit", "inherit"] as const,
  });
  const startupFailure = new Promise<never>((_, reject) => {
    child.once("exit", (code: number | null) =>
      reject(new Error(`${command} exited during startup with code ${code}`)),
    );
  });
  await Promise.race([
    startupFailure,
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  child.removeAllListeners("exit");
  return child;
}

export async function waitForHttpOk(
  url: string,
  { timeoutMs = 120_000, intervalMs = 500 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`${url} responded ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Timed out waiting for ${url} to respond OK: ${String(lastError)}`,
  );
}
