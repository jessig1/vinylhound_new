import { describe, expect, it } from "vitest";

import {
  GetUsageSummaryResponseSchema,
  USAGE_SUMMARY_WINDOW_DAYS,
  UsageOutcomeCountsSchema,
} from "./usage.ts";

const outcomes = {
  identified: 9,
  needsReview: 2,
  unresolved: 1,
  failed: 1,
  canceled: 0,
  inProgress: 1,
};

const summary = {
  windowDays: 30,
  since: "2026-08-11T00:00:00.000Z",
  scanCount: 14,
  outcomes,
  cost: {
    attemptCount: 15,
    totalInputTokens: 31_400,
    totalOutputTokens: 4_512,
    totalTokens: 35_912,
    estimatedCostUsd: 0.1147,
    averageDurationMs: 11_820,
  },
};

describe("UsageOutcomeCountsSchema", () => {
  it("counts every scan status bucket, including in-progress work", () => {
    expect(UsageOutcomeCountsSchema.parse(outcomes)).toEqual(outcomes);
  });

  it("rejects a negative or fractional count", () => {
    expect(() =>
      UsageOutcomeCountsSchema.parse({ ...outcomes, failed: -1 }),
    ).toThrow();
    expect(() =>
      UsageOutcomeCountsSchema.parse({ ...outcomes, identified: 1.5 }),
    ).toThrow();
  });

  it("rejects a bucket the dashboard would silently ignore", () => {
    expect(() =>
      UsageOutcomeCountsSchema.parse({ ...outcomes, retried: 0 }),
    ).toThrow();
  });
});

describe("GetUsageSummaryResponseSchema", () => {
  it("accepts a 30-day summary with aggregated cost", () => {
    expect(GetUsageSummaryResponseSchema.parse(summary)).toEqual(summary);
  });

  it("pins the window to the documented constant so clients need not guess", () => {
    expect(USAGE_SUMMARY_WINDOW_DAYS).toBe(30);
    expect(() =>
      GetUsageSummaryResponseSchema.parse({ ...summary, windowDays: 7 }),
    ).toThrow();
  });

  it("allows cost to be unknown when no priced model ran", () => {
    const unpriced = {
      ...summary,
      cost: {
        ...summary.cost,
        estimatedCostUsd: null,
        averageDurationMs: null,
      },
    };
    expect(GetUsageSummaryResponseSchema.parse(unpriced)).toEqual(unpriced);
  });

  it("requires an ISO timestamp for the window start", () => {
    expect(() =>
      GetUsageSummaryResponseSchema.parse({ ...summary, since: "2026-08-11" }),
    ).toThrow();
  });
});
