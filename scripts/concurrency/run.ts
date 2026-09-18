import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "pg";

import { MAX_SCANS_PER_BATCH } from "@vinylhound/contracts";
import { estimateTokenUsageCostUsd } from "@vinylhound/domain";

import {
  createBatch,
  newBenchUserId,
  runScanPipeline,
} from "../benchmark/client.ts";
import { loadImageFixture } from "../benchmark/fixture.ts";
import { round, summarize, type Percentiles } from "../benchmark/stats.ts";
import {
  ensureBenchDatabase,
  migrateBenchDatabase,
  resetBenchData,
} from "./db.ts";
import { BENCH_PORT, buildEnv, repoRoot, type WorkerMode } from "./env.ts";
import {
  renderMarkdown,
  type ConcurrencyReport,
  type LegSummary,
} from "./report.ts";
import { startWeb } from "./server.ts";
import { startWorkerFleet, type AnalysisTimingRecord } from "./workers.ts";

function intListFromEnv(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = raw
    .split(",")
    .map((v) => Number.parseInt(v.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length > 0 ? parsed : fallback;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function modesFromEnv(): WorkerMode[] {
  const raw = process.env.CONCURRENCY_MODES ?? "stub";
  const modes = raw
    .split(",")
    .map((m) => m.trim())
    .filter((m): m is WorkerMode => m === "stub" || m === "live");
  return modes.length > 0 ? modes : ["stub"];
}

const WORKER_COUNTS = intListFromEnv("CONCURRENCY_WORKER_COUNTS", [1, 2]);
const TOTAL_CONCURRENCY = intFromEnv("CONCURRENCY_TOTAL", 2);
const STUB_SCANS_PER_LEG = intFromEnv("CONCURRENCY_STUB_SCANS", 15);
const LIVE_SCANS_PER_LEG = intFromEnv("CONCURRENCY_LIVE_SCANS", 5);
const LIVE_SCAN_HARD_CAP = intFromEnv("CONCURRENCY_LIVE_HARD_CAP", 20);
const MODES = modesFromEnv();
const ANALYSIS_TIMEOUT_MS = intFromEnv(
  "CONCURRENCY_ANALYSIS_TIMEOUT_MS",
  600_000,
);

function gitCommit(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result.stdout.trim() || "unknown";
}

function gitDirty(): boolean {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result.stdout.trim().length > 0;
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function lane() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, lane),
  );
  return results;
}

// A batch holds at most MAX_SCANS_PER_BATCH scans; a leg's scan count can
// exceed that (a richer CONCURRENCY_STUB_SCANS run easily crosses 20), so
// scans are spread across as many batches as needed rather than assuming
// one batch always fits. This tool measures worker/provider concurrency,
// not the batch-row lock scripts/benchmark/'s multi-batch design already
// covers, so one user is enough here.
async function submitScans(
  baseUrl: string,
  count: number,
  concurrency: number,
) {
  const fixture = await loadImageFixture();
  const userId = newBenchUserId();
  const batchCount = Math.ceil(count / MAX_SCANS_PER_BATCH);
  const batchIds = await Promise.all(
    Array.from({ length: batchCount }, () => createBatch(baseUrl, userId)),
  );
  const batchForScan = (index: number) =>
    batchIds[Math.floor(index / MAX_SCANS_PER_BATCH)];
  return runWithConcurrency(
    Array.from({ length: count }, (_, index) => index),
    concurrency,
    (index) => runScanPipeline(baseUrl, userId, batchForScan(index), fixture),
  );
}

async function waitForDistinctScans(
  records: AnalysisTimingRecord[],
  target: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (new Set(records.map((r) => r.scanId)).size >= target) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `Timed out waiting for ${target} distinct scans to complete analysis (got ${new Set(records.map((r) => r.scanId)).size}).`,
  );
}

function roundPercentiles(p: Percentiles): Percentiles {
  return {
    count: p.count,
    min: round(p.min),
    p50: round(p.p50),
    p95: round(p.p95),
    p99: round(p.p99),
    max: round(p.max),
    mean: round(p.mean),
  };
}

/** Reads every succeeded attempt left in the (just-reset-per-leg) database and prices it. */
async function estimateLegCostUsd(databaseUrl: string): Promise<number | null> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{
      model: string;
      input_tokens: number | null;
      output_tokens: number | null;
    }>(
      "select model, input_tokens, output_tokens from scan_attempts where status = 'succeeded'",
    );
    let cost = 0;
    let priced = 0;
    for (const row of result.rows) {
      if (row.input_tokens === null || row.output_tokens === null) continue;
      const attemptCost = estimateTokenUsageCostUsd(row.model, {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
      });
      if (attemptCost === null) continue;
      cost += attemptCost;
      priced += 1;
    }
    return priced > 0 ? round(cost, 4) : null;
  } finally {
    await client.end();
  }
}

async function runLeg(
  mode: WorkerMode,
  workerCount: number,
  env: Record<string, string>,
  baseUrl: string,
): Promise<LegSummary> {
  await resetBenchData(env);
  const scanCount = mode === "stub" ? STUB_SCANS_PER_LEG : LIVE_SCANS_PER_LEG;

  console.info(
    `[concurrency] ${mode} / ${workerCount} worker(s) @ concurrency ${TOTAL_CONCURRENCY / workerCount} each: starting worker fleet…`,
  );
  const fleet = await startWorkerFleet(
    mode,
    workerCount,
    TOTAL_CONCURRENCY,
    env,
  );

  console.info(`[concurrency] submitting ${scanCount} scans…`);
  const submitStartedAt = performance.now();
  const pipelineResults = await submitScans(
    baseUrl,
    scanCount,
    TOTAL_CONCURRENCY,
  );
  const submissionWallClockMs = performance.now() - submitStartedAt;

  console.info(`[concurrency] waiting for analysis to complete…`);
  const analysisStartedAt = performance.now();
  await waitForDistinctScans(fleet.records, scanCount, ANALYSIS_TIMEOUT_MS);
  const analysisWallClockMs = performance.now() - analysisStartedAt;

  const estimatedCostUsd =
    mode === "live" ? await estimateLegCostUsd(env.DATABASE_URL) : null;

  fleet.stop();

  const distinctScanCount = new Set(fleet.records.map((r) => r.scanId)).size;
  const percentileFor = (key: keyof AnalysisTimingRecord) =>
    roundPercentiles(summarize(fleet.records.map((r) => r[key] as number)));

  const summary: LegSummary = {
    mode,
    workerCount,
    totalConcurrency: TOTAL_CONCURRENCY,
    perWorkerConcurrency: fleet.perWorkerConcurrency,
    requestedScanCount: scanCount,
    distinctScanCount,
    attemptCount: fleet.records.length,
    submissionWallClockMs: round(submissionWallClockMs),
    analysisWallClockMs: round(analysisWallClockMs),
    throughputScansPerMinute: round(
      (distinctScanCount / analysisWallClockMs) * 60_000,
      2,
    ),
    storageFetchMs: percentileFor("storageFetchDurationMs"),
    providerCallMs: percentileFor("providerCallDurationMs"),
    attemptDurationMs: percentileFor("durationMs"),
    estimatedCostUsd,
    pipelineOk: pipelineResults.every((r) => r.ok),
  };

  console.info(
    `[concurrency] ${mode}/${workerCount}: ${distinctScanCount}/${scanCount} scans, ` +
      `${summary.throughputScansPerMinute} scans/min, provider p50=${summary.providerCallMs.p50}ms` +
      `${estimatedCostUsd === null ? "" : `, est. cost $${estimatedCostUsd}`}`,
  );

  return summary;
}

async function main() {
  if (MODES.includes("live")) {
    const totalLiveScans = LIVE_SCANS_PER_LEG * WORKER_COUNTS.length;
    if (totalLiveScans > LIVE_SCAN_HARD_CAP) {
      throw new Error(
        `Refusing to start: mode=live would submit ${totalLiveScans} real scans ` +
          `(${LIVE_SCANS_PER_LEG} × ${WORKER_COUNTS.length} worker-count legs), ` +
          `above the ${LIVE_SCAN_HARD_CAP}-scan hard cap. Lower CONCURRENCY_LIVE_SCANS, ` +
          `CONCURRENCY_WORKER_COUNTS, or raise CONCURRENCY_LIVE_HARD_CAP explicitly.`,
      );
    }
    console.info(
      `[concurrency] mode=live will submit ${totalLiveScans} real scans across ${WORKER_COUNTS.length} worker-count leg(s) — this makes real, billable OpenAI calls.`,
    );
  }

  console.info("[concurrency] preparing the isolated database…");
  await ensureBenchDatabase();
  // Migrations only need real credentials for whichever mode runs last;
  // AUTH/queue/storage config is identical across modes, so build once with
  // a stub env and let per-leg envs override OPENAI_API_KEY only.
  migrateBenchDatabase(buildEnv("stub"));

  // Always the stub env, regardless of which modes run: apps/web never
  // calls the AI provider (AGENTS.md — "apps/web ... must never contain
  // provider secrets"), only the worker processes started per leg below do,
  // so only their env (buildEnv(mode) inside the loop) ever carries a real
  // OPENAI_API_KEY.
  const web = await startWeb(buildEnv("stub"));
  const baseUrl = `http://localhost:${BENCH_PORT}`;

  try {
    const legs: LegSummary[] = [];
    for (const mode of MODES) {
      const env = buildEnv(mode);
      for (const workerCount of WORKER_COUNTS) {
        legs.push(await runLeg(mode, workerCount, env, baseUrl));
      }
    }

    const report: ConcurrencyReport = {
      generatedAt: new Date().toISOString(),
      commit: gitCommit(),
      workingTreeDirty: gitDirty(),
      hardware: {
        platform: os.platform(),
        arch: os.arch(),
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        cpuCount: os.cpus().length,
        totalMemGiB: round(os.totalmem() / 2 ** 30, 1),
        nodeVersion: process.version,
      },
      fixture: {
        note: "one synthetic 600x600 solid-color JPEG, reused for every upload — real enough to pass validation and reach a real vision call, but not a real album cover, so live-mode token counts/cost are a floor, not a realistic estimate",
        image:
          "scripts/benchmark/fixture.ts (shared with the P3.5 Task 2 benchmark)",
      },
      legs,
    };

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const resultsDir = path.join(
      repoRoot,
      "scripts/concurrency/results",
      timestamp,
    );
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(
      path.join(resultsDir, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    writeFileSync(path.join(resultsDir, "summary.md"), renderMarkdown(report));
    console.info(
      `[concurrency] results written to scripts/concurrency/results/${timestamp}/`,
    );
  } finally {
    web.stop();
  }
}

void main().catch((error) => {
  console.error("[concurrency] failed:", error);
  process.exitCode = 1;
});
