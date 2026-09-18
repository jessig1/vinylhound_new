import type { Percentiles } from "../benchmark/stats.ts";
import type { WorkerMode } from "./env.ts";

export interface LegSummary {
  mode: WorkerMode;
  workerCount: number;
  totalConcurrency: number;
  perWorkerConcurrency: number;
  requestedScanCount: number;
  distinctScanCount: number;
  attemptCount: number;
  submissionWallClockMs: number;
  analysisWallClockMs: number;
  throughputScansPerMinute: number;
  storageFetchMs: Percentiles;
  providerCallMs: Percentiles;
  attemptDurationMs: Percentiles;
  /** Null for stub legs — there is nothing to price. */
  estimatedCostUsd: number | null;
  pipelineOk: boolean;
}

export interface ConcurrencyReport {
  generatedAt: string;
  commit: string;
  workingTreeDirty: boolean;
  hardware: {
    platform: string;
    arch: string;
    cpuModel: string;
    cpuCount: number;
    totalMemGiB: number;
    nodeVersion: string;
  };
  fixture: { note: string; image: string };
  legs: LegSummary[];
}

function percentileRow(label: string, p: Percentiles): string {
  return `| ${label} | ${p.count} | ${p.min} | ${p.p50} | ${p.p95} | ${p.p99} | ${p.max} | ${p.mean} |`;
}

export function renderMarkdown(report: ConcurrencyReport): string {
  const lines: string[] = [];
  lines.push("# P3.5 Task 4 concurrency comparison");
  lines.push("");
  lines.push(
    `Generated ${report.generatedAt} at commit \`${report.commit}\`${
      report.workingTreeDirty ? " (working tree had uncommitted changes)" : ""
    }.`,
  );
  lines.push("");
  lines.push(
    `${report.hardware.cpuModel} (${report.hardware.cpuCount} logical cores), ` +
      `${report.hardware.totalMemGiB} GiB RAM, ${report.hardware.platform}/${report.hardware.arch}, ` +
      `Node ${report.hardware.nodeVersion}. Not a dedicated benchmark machine — an interactive development laptop with other processes running; treat absolute numbers as illustrative and prefer relative comparisons across legs on the same machine.`,
  );
  lines.push("");
  lines.push(`Fixture: ${report.fixture.note} — ${report.fixture.image}`);
  lines.push("");
  lines.push(
    "Every mode/worker-count leg holds **total provider concurrency** " +
      "constant (`ANALYSIS_CONCURRENCY` split evenly across worker " +
      "processes) so a throughput difference reflects splitting work across " +
      "processes, not simply raising the concurrency ceiling.",
  );
  lines.push("");
  lines.push("## Legs");
  lines.push("");
  lines.push(
    "| Mode | Workers | Total concurrency | Per-worker | Scans | Attempts | Throughput (scans/min) | Est. cost |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const leg of report.legs) {
    lines.push(
      `| ${leg.mode} | ${leg.workerCount} | ${leg.totalConcurrency} | ${leg.perWorkerConcurrency} | ` +
        `${leg.distinctScanCount}/${leg.requestedScanCount} | ${leg.attemptCount} | ${leg.throughputScansPerMinute} | ` +
        `${leg.estimatedCostUsd === null ? "—" : `$${leg.estimatedCostUsd}`} |`,
    );
  }
  lines.push("");
  lines.push("## Application time vs. provider time, per leg");
  lines.push("");
  lines.push(
    "`storageFetch` is application time (reading the normalized image back " +
      "from object storage before the provider call); `providerCall` is " +
      "provider time (the AI adapter round trip); `attempt` is their " +
      "bundled total, the same value persisted to `scan_attempts.duration_ms`. " +
      "Milliseconds.",
  );
  lines.push("");
  for (const leg of report.legs) {
    lines.push(
      `### \`${leg.mode}\`, ${leg.workerCount} worker(s) @ concurrency ${leg.perWorkerConcurrency} each`,
    );
    lines.push("");
    lines.push("| Signal | n | min | p50 | p95 | p99 | max | mean |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    lines.push(percentileRow("storageFetch (application)", leg.storageFetchMs));
    lines.push(percentileRow("providerCall (provider)", leg.providerCallMs));
    lines.push(percentileRow("attempt (bundled total)", leg.attemptDurationMs));
    lines.push("");
  }
  return lines.join("\n");
}
