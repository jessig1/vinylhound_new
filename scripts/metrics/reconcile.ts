import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { estimateTokenUsageCostUsd } from "@vinylhound/domain";

import { databaseUrl, repoRoot } from "./env.ts";
import { readAttempts, type AttemptRow } from "./query.ts";
import {
  renderMarkdown,
  type ModelSummary,
  type ReconcileReport,
} from "./report.ts";
import { round, summarize } from "../benchmark/stats.ts";

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

/** Strips credentials so the report never embeds a password. */
function maskDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "unparseable connection string";
  }
}

function summaryFor(model: string, attempts: AttemptRow[]): ModelSummary {
  const succeededCount = attempts.filter(
    (a) => a.status === "succeeded",
  ).length;
  const failedCount = attempts.filter((a) => a.status === "failed").length;

  const attemptDurations = attempts
    .map((a) => a.durationMs)
    .filter((v): v is number => v !== null);

  const queueAges = attempts
    .filter((a) => a.enqueuedAt !== null)
    .map((a) => Date.parse(a.startedAt) - Date.parse(a.enqueuedAt!));

  const endToEnd = attempts
    .filter((a) => a.enqueuedAt !== null && a.completedAt !== null)
    .map((a) => Date.parse(a.completedAt!) - Date.parse(a.enqueuedAt!));

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let estimatedCostUsd = 0;
  let pricedAttemptCount = 0;
  let unpricedAttemptCount = 0;
  for (const attempt of attempts) {
    if (attempt.inputTokens === null || attempt.outputTokens === null) {
      unpricedAttemptCount += 1;
      continue;
    }
    totalInputTokens += attempt.inputTokens;
    totalOutputTokens += attempt.outputTokens;
    const cost = estimateTokenUsageCostUsd(model, {
      inputTokens: attempt.inputTokens,
      outputTokens: attempt.outputTokens,
    });
    if (cost === null) {
      unpricedAttemptCount += 1;
      continue;
    }
    estimatedCostUsd += cost;
    pricedAttemptCount += 1;
  }

  const roundPercentiles = (samples: number[]) => {
    const p = summarize(samples);
    return {
      count: p.count,
      min: round(p.min),
      p50: round(p.p50),
      p95: round(p.p95),
      p99: round(p.p99),
      max: round(p.max),
      mean: round(p.mean),
    };
  };

  return {
    model,
    attemptCount: attempts.length,
    succeededCount,
    failedCount,
    errorRate: round(failedCount / attempts.length, 4),
    attemptDurationMs: roundPercentiles(attemptDurations),
    queueAgeMs: roundPercentiles(queueAges),
    queueAgeSampleCount: queueAges.length,
    endToEndMs: roundPercentiles(endToEnd),
    endToEndSampleCount: endToEnd.length,
    totalInputTokens,
    totalOutputTokens,
    estimatedCostUsd:
      pricedAttemptCount > 0 ? round(estimatedCostUsd, 4) : null,
    unpricedAttemptCount,
  };
}

async function main() {
  const url = databaseUrl();
  console.info(
    `[metrics] reading persisted attempts from ${maskDatabaseUrl(url)}…`,
  );
  const attempts = await readAttempts(url);

  if (attempts.length === 0) {
    console.info(
      "[metrics] no scan_attempts rows found — nothing to reconcile. Run some real scans first.",
    );
    return;
  }

  const byModelMap = new Map<string, AttemptRow[]>();
  for (const attempt of attempts) {
    const bucket = byModelMap.get(attempt.model) ?? [];
    bucket.push(attempt);
    byModelMap.set(attempt.model, bucket);
  }
  const byModel = [...byModelMap.entries()]
    .sort(([, a], [, b]) => b.length - a.length)
    .map(([model, rows]) => summaryFor(model, rows));

  const startedTimes = attempts.map((a) => Date.parse(a.startedAt));
  const earliestMs = Math.min(...startedTimes);
  const latestMs = Math.max(...startedTimes);
  const days = Math.max(
    (latestMs - earliestMs) / (1000 * 60 * 60 * 24),
    1 / 24,
  );

  const failedTotal = attempts.filter((a) => a.status === "failed").length;
  const estimatedTotalCostUsd = byModel.reduce(
    (sum, m) => sum + (m.estimatedCostUsd ?? 0),
    0,
  );

  const report: ReconcileReport = {
    generatedAt: new Date().toISOString(),
    commit: gitCommit(),
    workingTreeDirty: gitDirty(),
    database: maskDatabaseUrl(url),
    observedWindow: {
      earliest: new Date(earliestMs).toISOString(),
      latest: new Date(latestMs).toISOString(),
      days: round(days, 2),
    },
    overall: {
      attemptCount: attempts.length,
      errorRate: round(failedTotal / attempts.length, 4),
      throughputPerDay: round(attempts.length / days, 2),
      estimatedTotalCostUsd: round(estimatedTotalCostUsd, 4),
    },
    byModel,
  };

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = path.join(repoRoot, "scripts/metrics/results", timestamp);
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(
    path.join(resultsDir, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  writeFileSync(path.join(resultsDir, "summary.md"), renderMarkdown(report));
  console.info(
    `[metrics] ${attempts.length} attempts across ${byModel.length} model(s) reconciled; results written to scripts/metrics/results/${timestamp}/`,
  );
}

void main().catch((error) => {
  console.error("[metrics] failed:", error);
  process.exitCode = 1;
});
