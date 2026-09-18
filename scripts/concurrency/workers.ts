import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

import { stopProcess } from "../benchmark/process-utils.ts";
import { repoRoot, type WorkerMode } from "./env.ts";

export interface AnalysisTimingRecord {
  scanId: string;
  attemptId: string;
  outcome: string;
  storageFetchDurationMs: number;
  providerCallDurationMs: number;
  durationMs: number;
}

export interface WorkerFleet {
  /** One entry per `scan_analysis_timing` line any process in the fleet has emitted so far — grows live as the run progresses. */
  records: AnalysisTimingRecord[];
  perWorkerConcurrency: number;
  stop(): void;
}

const ENTRYPOINT: Record<WorkerMode, string> = {
  stub: "apps/worker/src/e2e-worker.ts",
  live: "apps/worker/src/index.ts",
};

// Both entrypoints' own startup line (apps/worker/src/e2e-worker.ts:149,
// apps/worker/src/index.ts's `console.info("[worker] started", ...)`) is
// searched for as a literal substring, not a parsed JSON field: that
// `console.info(prefix, object)` call is not itself JSON.stringify'd (only
// the three "timing" lines were fixed in P3.5 Task 3), so its first printed
// line reliably contains the prefix text regardless of how the rest of the
// object wraps.
const READY_TEXT: Record<WorkerMode, string> = {
  stub: "synthetic scan worker started",
  live: "[worker] started",
};

function waitForReady(child: ChildProcess, readyText: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: child.stdout! });
    const onLine = (line: string) => {
      if (line.includes(readyText)) {
        rl.off("line", onLine);
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      rl.off("line", onLine);
      reject(new Error(`worker exited during startup with code ${code}`));
    };
    rl.on("line", onLine);
    child.once("exit", onExit);
  });
}

/**
 * Every `scan_analysis_timing` line (now single-line JSON as of P3.5
 * Task 3) is captured directly from the worker's own stdout rather than
 * read back from the database — `scan_attempts` never persisted the
 * storage-fetch/provider-call split, only the bundled `duration_ms`, so the
 * log line is the only source for the application-time/provider-time split
 * this task needs.
 */
function attachRecordCapture(
  child: ChildProcess,
  records: AnalysisTimingRecord[],
): void {
  const rl = readline.createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { event?: unknown }).event === "scan_analysis_timing"
    ) {
      records.push(parsed as AnalysisTimingRecord);
    }
  });
}

/**
 * Starts `workerCount` worker processes of the given mode, splitting
 * `totalConcurrency` evenly across them via `ANALYSIS_CONCURRENCY` — the
 * roadmap task's explicit requirement to hold total provider concurrency
 * constant when comparing one worker against several, so a throughput
 * difference reflects process-level parallelism rather than simply more
 * concurrent provider calls.
 */
export async function startWorkerFleet(
  mode: WorkerMode,
  workerCount: number,
  totalConcurrency: number,
  env: Record<string, string>,
): Promise<WorkerFleet> {
  if (totalConcurrency % workerCount !== 0) {
    throw new Error(
      `totalConcurrency (${totalConcurrency}) must divide evenly by workerCount (${workerCount}) so every worker gets equal concurrency.`,
    );
  }
  const perWorkerConcurrency = totalConcurrency / workerCount;
  const records: AnalysisTimingRecord[] = [];
  const processes: ChildProcess[] = [];

  for (let i = 0; i < workerCount; i++) {
    const child = spawn(
      process.execPath,
      [
        path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"),
        path.join(repoRoot, ENTRYPOINT[mode]),
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          ...env,
          ANALYSIS_CONCURRENCY: String(perWorkerConcurrency),
        },
        // stderr inherited so a real crash is visible immediately; stdout
        // piped so this process can read it line by line for both the
        // ready signal and the timing records.
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    processes.push(child);
    attachRecordCapture(child, records);
    await waitForReady(child, READY_TEXT[mode]);
  }

  return {
    records,
    perWorkerConcurrency,
    stop() {
      for (const child of processes) {
        stopProcess(child);
      }
    },
  };
}
