import type { AnalyzeScanJob } from "@vinylhound/contracts";

export const ANALYZE_SCAN_JOB = "scan.analyze.v1";

export interface ScanQueue {
  enqueueAnalyzeScan(
    payload: AnalyzeScanJob,
    idempotencyKey: string,
  ): Promise<{ jobId: string }>;
}
