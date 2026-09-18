import { randomUUID } from "node:crypto";

import type { ImageFixture } from "./fixture.ts";

export interface StepResult {
  step: string;
  status: number;
  ok: boolean;
  durationMs: number;
}

export interface ScanPipelineResult {
  userId: string;
  batchId?: string;
  scanId?: string;
  steps: StepResult[];
  ok: boolean;
  totalDurationMs: number;
}

async function timedRequest(
  step: string,
  input: string,
  init: RequestInit,
): Promise<{ result: StepResult; response: Response }> {
  const startedAt = performance.now();
  const response = await fetch(input, init);
  const durationMs = performance.now() - startedAt;
  return {
    result: { step, status: response.status, ok: response.ok, durationMs },
    response,
  };
}

function benchHeaders(userId: string, extra?: Record<string, string>) {
  return {
    "content-type": "application/json",
    "x-vinylhound-bench-user-id": userId,
    "idempotency-key": randomUUID(),
    ...extra,
  };
}

/**
 * Runs one full scan pipeline against the real HTTP API: create batch,
 * create scan (batch_upload, so createOrGetScan's batch-row lock is always
 * exercised), create a signed upload, PUT the fixture bytes to storage,
 * complete the upload (real readback + validate + normalize), then submit
 * (where enforceScanQuota's per-user advisory lock fires). Each caller
 * supplies its own userId/batchId so concurrent pipelines land on distinct
 * locks rather than serializing on one.
 */
export async function runScanPipeline(
  baseUrl: string,
  userId: string,
  batchId: string,
  fixture: ImageFixture,
): Promise<ScanPipelineResult> {
  const steps: StepResult[] = [];
  const startedAt = performance.now();

  const scan = await timedRequest("scans.create", `${baseUrl}/api/v1/scans`, {
    method: "POST",
    headers: benchHeaders(userId),
    body: JSON.stringify({ source: "batch_upload", batchId }),
  });
  steps.push(scan.result);
  if (!scan.result.ok) {
    return finish(userId, steps, startedAt, batchId);
  }
  const scanBody = (await scan.response.json()) as { scanId: string };
  const scanId = scanBody.scanId;

  const upload = await timedRequest(
    "uploads.create",
    `${baseUrl}/api/v1/scans/${scanId}/uploads`,
    {
      method: "POST",
      headers: benchHeaders(userId),
      body: JSON.stringify({
        filename: "cover.jpg",
        mimeType: fixture.mimeType,
        sizeBytes: fixture.sizeBytes,
        checksumSha256: fixture.checksumSha256,
      }),
    },
  );
  steps.push(upload.result);
  if (!upload.result.ok) {
    return finish(userId, steps, startedAt, batchId, scanId);
  }
  const signed = (await upload.response.json()) as {
    imageId: string;
    method: "PUT";
    url: string;
    requiredHeaders: Record<string, string>;
  };

  const put = await timedRequest("storage.put", signed.url, {
    method: signed.method,
    headers: signed.requiredHeaders,
    // A plain Buffer's ArrayBufferLike generic doesn't satisfy DOM's
    // BodyInit under this repo's TS/lib settings; a fresh copy backed by a
    // real ArrayBuffer does.
    body: new Uint8Array(fixture.bytes),
  });
  steps.push(put.result);
  if (!put.result.ok) {
    return finish(userId, steps, startedAt, batchId, scanId);
  }

  const complete = await timedRequest(
    "uploads.complete",
    `${baseUrl}/api/v1/scans/${scanId}/uploads/${signed.imageId}/complete`,
    { method: "POST", headers: benchHeaders(userId) },
  );
  steps.push(complete.result);
  if (!complete.result.ok) {
    return finish(userId, steps, startedAt, batchId, scanId);
  }

  const submit = await timedRequest(
    "scans.submit",
    `${baseUrl}/api/v1/scans/${scanId}/submit`,
    { method: "POST", headers: benchHeaders(userId) },
  );
  steps.push(submit.result);

  return finish(userId, steps, startedAt, batchId, scanId);
}

function finish(
  userId: string,
  steps: StepResult[],
  startedAt: number,
  batchId?: string,
  scanId?: string,
): ScanPipelineResult {
  return {
    userId,
    batchId,
    scanId,
    steps,
    ok: steps.every((step) => step.ok),
    totalDurationMs: performance.now() - startedAt,
  };
}

export async function createBatch(
  baseUrl: string,
  userId: string,
): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/batches`, {
    method: "POST",
    headers: benchHeaders(userId),
  });
  if (!response.ok) {
    throw new Error(
      `createBatch failed for user ${userId}: ${response.status}`,
    );
  }
  const body = (await response.json()) as { batchId: string };
  return body.batchId;
}

export function newBenchUserId(): string {
  return randomUUID();
}
