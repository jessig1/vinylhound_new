import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ensureBenchDatabase,
  migrateBenchDatabase,
  resetBenchData,
} from "./db.ts";
import { loadImageFixture } from "./fixture.ts";
import { BENCH_PORT, buildBenchEnv, repoRoot } from "./env.ts";
import { renderMarkdown, type BenchReport, type RunSummary } from "./report.ts";
import { startBenchStack } from "./server.ts";
import { round, summarize, type Percentiles } from "./stats.ts";
import {
  runWorkload,
  type WorkloadConfig,
  type WorkloadOutcome,
} from "./workload.ts";

const config: WorkloadConfig = {
  users: intFromEnv("BENCH_USERS", 5),
  batchesPerUser: intFromEnv("BENCH_BATCHES_PER_USER", 2),
  scansPerBatch: intFromEnv("BENCH_SCANS_PER_BATCH", 5),
  concurrency: intFromEnv("BENCH_CONCURRENCY", 10),
};
const RUN_COUNT = intFromEnv("BENCH_RUNS", 3);
const WARMUP_CONFIG: WorkloadConfig = {
  users: 2,
  batchesPerUser: 1,
  scansPerBatch: 3,
  concurrency: config.concurrency,
};

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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

interface StepBreakdown {
  [step: string]: Percentiles;
}

function stepBreakdown(outcome: WorkloadOutcome): StepBreakdown {
  const byStep = new Map<string, number[]>();
  for (const result of outcome.results) {
    for (const step of result.steps) {
      const samples = byStep.get(step.step) ?? [];
      samples.push(step.durationMs);
      byStep.set(step.step, samples);
    }
  }
  const breakdown: StepBreakdown = {};
  for (const [step, samples] of byStep) {
    breakdown[step] = mapPercentiles(summarize(samples));
  }
  return breakdown;
}

function mapPercentiles(p: Percentiles): Percentiles {
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

function summarizeRun(outcome: WorkloadOutcome): RunSummary {
  const successCount = outcome.results.filter((r) => r.ok).length;
  const errorCount = outcome.results.length - successCount;
  const pipelineLatency = mapPercentiles(
    summarize(outcome.results.map((r) => r.totalDurationMs)),
  );
  return {
    config: outcome.config,
    totalScans: outcome.totalScans,
    wallClockMs: round(outcome.wallClockMs),
    throughputScansPerSec: round(
      outcome.totalScans / (outcome.wallClockMs / 1000),
    ),
    successCount,
    errorCount,
    errorRate: round(errorCount / outcome.results.length, 4),
    pipelineLatencyMs: pipelineLatency,
    stepLatencyMs: stepBreakdown(outcome),
  };
}

async function main() {
  const env = buildBenchEnv();

  console.info("[benchmark] preparing the isolated benchmark database…");
  await ensureBenchDatabase();
  migrateBenchDatabase(env);
  await resetBenchData(env);

  const stack = await startBenchStack(env);
  const baseUrl = `http://localhost:${BENCH_PORT}`;

  try {
    const fixture = await loadImageFixture();

    console.info(
      `[benchmark] warmup pass (${WARMUP_CONFIG.users} users × ${WARMUP_CONFIG.batchesPerUser} batches × ${WARMUP_CONFIG.scansPerBatch} scans, discarded)…`,
    );
    await runWorkload(baseUrl, fixture, WARMUP_CONFIG);

    const runs: RunSummary[] = [];
    for (let run = 1; run <= RUN_COUNT; run++) {
      console.info(
        `[benchmark] run ${run}/${RUN_COUNT}: ${config.users} users × ${config.batchesPerUser} batches × ${config.scansPerBatch} scans, concurrency ${config.concurrency}…`,
      );
      const outcome = await runWorkload(baseUrl, fixture, config);
      const summary = summarizeRun(outcome);
      console.info(
        `[benchmark] run ${run} done: ${summary.successCount}/${summary.totalScans} ok, ` +
          `${summary.throughputScansPerSec} scans/s, p50=${summary.pipelineLatencyMs.p50}ms p95=${summary.pipelineLatencyMs.p95}ms`,
      );
      runs.push(summary);
    }

    const report: BenchReport = {
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
      target: {
        mode: "local production standalone build (next build, single web replica, single worker replica)",
        database: "dedicated local PostgreSQL (docker compose), migrated fresh",
        queue: "dedicated local Redis/BullMQ queue",
        objectStorage:
          "local MinIO (real presigned S3-compatible PUT round trip)",
        aiAdapter:
          "synthetic (apps/worker/src/e2e-worker.ts); no OpenAI calls, no provider spend",
      },
      dataset: {
        note: `${config.users} distinct synthetic users, ${config.batchesPerUser} batches per user, ${config.scansPerBatch} scans per batch (${config.users * config.batchesPerUser * config.scansPerBatch} scans/run). Fresh random user IDs every run, so pg_advisory_xact_lock(hashtext(userId)) in enforceScanQuota and the batch row SELECT ... FOR UPDATE in createOrGetScan are both exercised across many independent lock targets rather than one, and no quota state carries over between runs (see docs/PHASE_3_4_PLAN_REVIEW.md).`,
        image: "one synthetic 600x600 JPEG, reused for every upload",
      },
      warmup: {
        config: WARMUP_CONFIG,
        note: "run once immediately after the stack reports ready; discarded from all reported metrics",
      },
      cacheState:
        "single long-lived web + worker process for the warmup pass and all timed runs below (warm DB/Redis/MinIO connection pools and JIT); no restart between runs",
      runs,
    };

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const resultsDir = path.join(
      repoRoot,
      "scripts/benchmark/results",
      timestamp,
    );
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(
      path.join(resultsDir, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    writeFileSync(path.join(resultsDir, "summary.md"), renderMarkdown(report));
    console.info(
      `[benchmark] results written to scripts/benchmark/results/${timestamp}/`,
    );
  } finally {
    stack.stop();
  }
}

void main().catch((error) => {
  console.error("[benchmark] failed:", error);
  process.exitCode = 1;
});
