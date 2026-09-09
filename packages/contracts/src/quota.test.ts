import { describe, expect, it } from "vitest";

import { GetQuotaHeadroomResponseSchema } from "./quota.js";

describe("GetQuotaHeadroomResponseSchema", () => {
  it("accepts an admissible headroom snapshot with no blocking reason", () => {
    const parsed = GetQuotaHeadroomResponseSchema.parse({
      checkedAt: new Date().toISOString(),
      limits: {
        dailyAnalysisLimit: 100,
        activeScanLimit: 20,
        monthlySpendLimitUsd: 20,
        scanCostReservationUsd: 0.25,
      },
      dailyAnalysis: { used: 3, limit: 100, remaining: 97 },
      activeScans: { used: 1, limit: 20, remaining: 19 },
      monthlySpend: {
        used: 1.5,
        limit: 20,
        remaining: 18.5,
        reservedUsd: 0.5,
      },
      admissible: true,
      blockedBy: null,
    });

    expect(parsed.admissible).toBe(true);
    expect(parsed.blockedBy).toBeNull();
  });

  it("accepts a blocked snapshot naming the limiting dimension", () => {
    const parsed = GetQuotaHeadroomResponseSchema.parse({
      checkedAt: new Date().toISOString(),
      limits: {
        dailyAnalysisLimit: 100,
        activeScanLimit: 20,
        monthlySpendLimitUsd: 20,
        scanCostReservationUsd: 0.25,
      },
      dailyAnalysis: { used: 100, limit: 100, remaining: 0 },
      activeScans: { used: 1, limit: 20, remaining: 19 },
      monthlySpend: { used: 1, limit: 20, remaining: 19, reservedUsd: 0.5 },
      admissible: false,
      blockedBy: "daily_analysis_limit",
    });

    expect(parsed.blockedBy).toBe("daily_analysis_limit");
  });

  it("rejects an unknown blocking reason", () => {
    const result = GetQuotaHeadroomResponseSchema.safeParse({
      checkedAt: new Date().toISOString(),
      limits: {
        dailyAnalysisLimit: 100,
        activeScanLimit: 20,
        monthlySpendLimitUsd: 20,
        scanCostReservationUsd: 0.25,
      },
      dailyAnalysis: { used: 0, limit: 100, remaining: 100 },
      activeScans: { used: 0, limit: 20, remaining: 20 },
      monthlySpend: { used: 0, limit: 20, remaining: 20, reservedUsd: 0 },
      admissible: false,
      blockedBy: "unknown_reason",
    });

    expect(result.success).toBe(false);
  });
});
