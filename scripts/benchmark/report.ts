import type { Percentiles } from "./stats.ts";
import type { WorkloadConfig } from "./workload.ts";

export interface RunSummary {
  config: WorkloadConfig;
  totalScans: number;
  wallClockMs: number;
  throughputScansPerSec: number;
  successCount: number;
  errorCount: number;
  errorRate: number;
  pipelineLatencyMs: Percentiles;
  stepLatencyMs: Record<string, Percentiles>;
}

export interface BenchReport {
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
  target: {
    mode: string;
    database: string;
    queue: string;
    objectStorage: string;
    aiAdapter: string;
  };
  dataset: { note: string; image: string };
  warmup: { config: WorkloadConfig; note: string };
  cacheState: string;
  runs: RunSummary[];
}

function percentileRow(label: string, p: Percentiles): string {
  return `| ${label} | ${p.count} | ${p.min} | ${p.p50} | ${p.p95} | ${p.p99} | ${p.max} | ${p.mean} |`;
}

export function renderMarkdown(report: BenchReport): string {
  const lines: string[] = [];
  lines.push("# P3.5 Task 2 benchmark results");
  lines.push("");
  lines.push(
    `Generated ${report.generatedAt} at commit \`${report.commit}\`${
      report.workingTreeDirty ? " (working tree had uncommitted changes)" : ""
    }.`,
  );
  lines.push("");
  lines.push("## Hardware / tier");
  lines.push("");
  lines.push(
    `${report.hardware.cpuModel} (${report.hardware.cpuCount} logical cores), ` +
      `${report.hardware.totalMemGiB} GiB RAM, ${report.hardware.platform}/${report.hardware.arch}, ` +
      `Node ${report.hardware.nodeVersion}. Not a dedicated benchmark machine — an interactive development laptop with other processes running; treat absolute numbers as illustrative and prefer relative comparisons across runs on the same machine.`,
  );
  lines.push("");
  lines.push("## Target");
  lines.push("");
  for (const [key, value] of Object.entries(report.target)) {
    lines.push(`- **${key}**: ${value}`);
  }
  lines.push("");
  lines.push("## Dataset");
  lines.push("");
  lines.push(`- ${report.dataset.note}`);
  lines.push(`- Image: ${report.dataset.image}`);
  lines.push("");
  lines.push("## Cache state and warmup");
  lines.push("");
  lines.push(`- ${report.cacheState}`);
  lines.push(
    `- Warmup: ${report.warmup.config.users} users × ${report.warmup.config.batchesPerUser} batches × ${report.warmup.config.scansPerBatch} scans. ${report.warmup.note}`,
  );
  lines.push("");
  lines.push("## Runs");
  lines.push("");
  for (const [index, run] of report.runs.entries()) {
    lines.push(
      `### Run ${index + 1} — ${run.config.users} users × ${run.config.batchesPerUser} batches × ${run.config.scansPerBatch} scans, concurrency ${run.config.concurrency}`,
    );
    lines.push("");
    lines.push(
      `${run.totalScans} scans, ${run.successCount} ok / ${run.errorCount} failed (error rate ${run.errorRate}), ` +
        `wall clock ${run.wallClockMs} ms, throughput ${run.throughputScansPerSec} scans/s.`,
    );
    lines.push("");
    lines.push("Latencies in milliseconds.");
    lines.push("");
    lines.push("| Step | n | min | p50 | p95 | p99 | max | mean |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    lines.push(percentileRow("full pipeline", run.pipelineLatencyMs));
    for (const [step, percentiles] of Object.entries(run.stepLatencyMs)) {
      lines.push(percentileRow(step, percentiles));
    }
    lines.push("");
  }
  return lines.join("\n");
}
