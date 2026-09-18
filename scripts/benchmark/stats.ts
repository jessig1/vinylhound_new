export interface Percentiles {
  count: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function summarize(samplesMs: number[]): Percentiles {
  if (samplesMs.length === 0) {
    return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
