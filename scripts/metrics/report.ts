import type { Percentiles } from "../benchmark/stats.ts";

export interface ModelSummary {
  model: string;
  attemptCount: number;
  succeededCount: number;
  failedCount: number;
  errorRate: number;
  attemptDurationMs: Percentiles;
  queueAgeMs: Percentiles;
  queueAgeSampleCount: number;
  endToEndMs: Percentiles;
  endToEndSampleCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Null when this model has no entry in the domain pricing table. */
  estimatedCostUsd: number | null;
  unpricedAttemptCount: number;
}

export interface ReconcileReport {
  generatedAt: string;
  commit: string;
  workingTreeDirty: boolean;
  database: string;
  observedWindow: {
    earliest: string | null;
    latest: string | null;
    days: number;
  };
  overall: {
    attemptCount: number;
    errorRate: number;
    throughputPerDay: number;
    estimatedTotalCostUsd: number;
  };
  byModel: ModelSummary[];
}

function percentileRow(label: string, p: Percentiles): string {
  return `| ${label} | ${p.count} | ${p.min} | ${p.p50} | ${p.p95} | ${p.p99} | ${p.max} | ${p.mean} |`;
}

export function renderMarkdown(report: ReconcileReport): string {
  const lines: string[] = [];
  lines.push("# P3.5 Task 3 persisted-attempt reconciliation");
  lines.push("");
  lines.push(
    `Generated ${report.generatedAt} at commit \`${report.commit}\`${
      report.workingTreeDirty ? " (working tree had uncommitted changes)" : ""
    }, against \`${report.database}\`.`,
  );
  lines.push("");
  lines.push(
    "**This reads whatever database the running instance actually used** — " +
      "a local development database by default, not a load-test fixture. " +
      "Sample counts, throughput, and queue age reflect real but sparse " +
      "developer testing cadence (the worker is not continuously running " +
      "between sessions), not production traffic; treat single-digit or " +
      "low-double-digit sample counts as illustrative, not statistically " +
      "reliable percentiles.",
  );
  lines.push("");
  lines.push("## Observed window");
  lines.push("");
  lines.push(
    `${report.observedWindow.earliest ?? "n/a"} to ${report.observedWindow.latest ?? "n/a"} ` +
      `(${report.observedWindow.days} days).`,
  );
  lines.push("");
  lines.push("## Overall");
  lines.push("");
  lines.push(`- **Attempts**: ${report.overall.attemptCount}`);
  lines.push(`- **Error rate**: ${report.overall.errorRate}`);
  lines.push(
    `- **Throughput**: ${report.overall.throughputPerDay} attempts/day (average over the observed window, not a load-test figure)`,
  );
  lines.push(
    `- **Estimated total AI cost**: $${report.overall.estimatedTotalCostUsd} (sum of priced attempts only; see per-model breakdown for unpriced counts)`,
  );
  lines.push("");
  lines.push("## By model");
  lines.push("");
  for (const model of report.byModel) {
    lines.push(`### \`${model.model}\``);
    lines.push("");
    lines.push(
      `${model.attemptCount} attempts, ${model.succeededCount} succeeded / ${model.failedCount} failed ` +
        `(error rate ${model.errorRate}). ${model.totalInputTokens} input + ${model.totalOutputTokens} output tokens. ` +
        `Estimated cost: ${model.estimatedCostUsd === null ? "not priced (no domain pricing entry for this model)" : `$${model.estimatedCostUsd}`}` +
        `${model.unpricedAttemptCount > 0 ? ` (${model.unpricedAttemptCount} attempt(s) excluded — missing token counts or no pricing entry)` : ""}.`,
    );
    lines.push("");
    lines.push(
      `Queue age (enqueue → worker pickup): ${model.queueAgeSampleCount} of ${model.attemptCount} attempts had a matching outbox row still available.`,
    );
    lines.push(
      `End-to-end latency (enqueue → attempt completion): ${model.endToEndSampleCount} of ${model.attemptCount} attempts.`,
    );
    lines.push("");
    lines.push("Milliseconds.");
    lines.push("");
    lines.push("| Signal | n | min | p50 | p95 | p99 | max | mean |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    lines.push(percentileRow("attempt duration", model.attemptDurationMs));
    lines.push(percentileRow("queue age", model.queueAgeMs));
    lines.push(percentileRow("end-to-end latency", model.endToEndMs));
    lines.push("");
  }
  return lines.join("\n");
}
