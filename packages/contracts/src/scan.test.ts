import { describe, expect, it } from "vitest";

import {
  CancelScanResponseSchema,
  CreateScanRequestSchema,
  RETRYABLE_SCAN_STATUSES,
  RetryScanResponseSchema,
  ScanStatusSchema,
} from "./scan.js";

describe("CreateScanRequestSchema", () => {
  it("preserves the single-scan shape by making batchId optional", () => {
    expect(CreateScanRequestSchema.parse({ source: "single_upload" })).toEqual({
      source: "single_upload",
    });
  });

  it("accepts a batch scan grouped under a batch ID", () => {
    expect(
      CreateScanRequestSchema.parse({
        source: "single_upload",
        batchId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toMatchObject({ batchId: "00000000-0000-4000-8000-000000000001" });
  });
});

describe("ScanStatusSchema", () => {
  it("accepts the canceled terminal status", () => {
    expect(ScanStatusSchema.parse("canceled")).toBe("canceled");
  });
});

describe("RETRYABLE_SCAN_STATUSES", () => {
  it("only allows retrying failed or unresolved scans", () => {
    expect(RETRYABLE_SCAN_STATUSES).toEqual(["failed", "unresolved"]);
  });
});

describe("RetryScanResponseSchema", () => {
  it("mirrors the submit response shape", () => {
    expect(
      RetryScanResponseSchema.parse({
        scanId: "00000000-0000-4000-8000-000000000001",
        status: "queued",
        attemptNumber: 2,
        jobId: "scan-00000000-0000-4000-8000-000000000001-attempt-2",
      }),
    ).toMatchObject({ attemptNumber: 2 });
  });
});

describe("CancelScanResponseSchema", () => {
  it("only accepts the canceled terminal status", () => {
    expect(
      CancelScanResponseSchema.parse({
        scanId: "00000000-0000-4000-8000-000000000001",
        status: "canceled",
      }),
    ).toMatchObject({ status: "canceled" });
    expect(() =>
      CancelScanResponseSchema.parse({
        scanId: "00000000-0000-4000-8000-000000000001",
        status: "failed",
      }),
    ).toThrow();
  });
});
