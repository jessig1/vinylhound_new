import { z } from "zod";

import { UsageCostSummarySchema } from "./scan.js";

export const USAGE_SUMMARY_WINDOW_DAYS = 30;

export const UsageOutcomeCountsSchema = z
  .object({
    identified: z.number().int().nonnegative(),
    needsReview: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    canceled: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
  })
  .strict();

export const GetUsageSummaryResponseSchema = z
  .object({
    windowDays: z.literal(USAGE_SUMMARY_WINDOW_DAYS),
    since: z.string().datetime(),
    scanCount: z.number().int().nonnegative(),
    outcomes: UsageOutcomeCountsSchema,
    cost: UsageCostSummarySchema,
  })
  .strict();

export type UsageOutcomeCounts = z.infer<typeof UsageOutcomeCountsSchema>;
export type GetUsageSummaryResponse = z.infer<
  typeof GetUsageSummaryResponseSchema
>;
