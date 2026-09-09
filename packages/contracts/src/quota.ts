import { z } from "zod";

export const ScanQuotaLimitsSchema = z
  .object({
    dailyAnalysisLimit: z.number().int().positive(),
    activeScanLimit: z.number().int().positive(),
    monthlySpendLimitUsd: z.number().positive(),
    scanCostReservationUsd: z.number().positive(),
  })
  .strict();

export const QuotaHeadroomReasonSchema = z.enum([
  "daily_analysis_limit",
  "active_scan_limit",
  "monthly_spend_limit",
]);

export const QuotaDimensionSchema = z
  .object({
    used: z.number().nonnegative(),
    limit: z.number().positive(),
    remaining: z.number().nonnegative(),
  })
  .strict();

export const QuotaSpendDimensionSchema = QuotaDimensionSchema.extend({
  reservedUsd: z.number().nonnegative(),
}).strict();

// Advisory: reports the same limits `submitScan`/`retryScan` enforce
// transactionally, but this read takes no per-user lock, so it can be
// stale under concurrency. A client should use it to decide whether to
// start expensive upload work, never as proof that a later submit will
// succeed.
export const GetQuotaHeadroomResponseSchema = z
  .object({
    checkedAt: z.string().datetime(),
    limits: ScanQuotaLimitsSchema,
    dailyAnalysis: QuotaDimensionSchema,
    activeScans: QuotaDimensionSchema,
    monthlySpend: QuotaSpendDimensionSchema,
    admissible: z.boolean(),
    blockedBy: QuotaHeadroomReasonSchema.nullable(),
  })
  .strict();

export type ScanQuotaLimits = z.infer<typeof ScanQuotaLimitsSchema>;
export type QuotaHeadroomReason = z.infer<typeof QuotaHeadroomReasonSchema>;
export type QuotaDimension = z.infer<typeof QuotaDimensionSchema>;
export type QuotaSpendDimension = z.infer<typeof QuotaSpendDimensionSchema>;
export type GetQuotaHeadroomResponse = z.infer<
  typeof GetQuotaHeadroomResponseSchema
>;
