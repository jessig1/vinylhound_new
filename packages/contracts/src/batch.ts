import { z } from "zod";

import { ScanCandidateResultSchema, ScanStatusSchema } from "./scan.js";

export const MAX_SCANS_PER_BATCH = 20;

export const CreateBatchRequestSchema = z.object({}).strict();

export const CreateBatchResponseSchema = z
  .object({
    batchId: z.string().uuid(),
    createdAt: z.string().datetime(),
  })
  .strict();

export const BatchScanSummarySchema = z
  .object({
    scanId: z.string().uuid(),
    status: ScanStatusSchema,
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    topCandidate: ScanCandidateResultSchema.nullable(),
  })
  .strict();

export const GetBatchResponseSchema = z
  .object({
    batchId: z.string().uuid(),
    createdAt: z.string().datetime(),
    scans: z.array(BatchScanSummarySchema).max(MAX_SCANS_PER_BATCH),
  })
  .strict();

export type CreateBatchRequest = z.infer<typeof CreateBatchRequestSchema>;
export type CreateBatchResponse = z.infer<typeof CreateBatchResponseSchema>;
export type BatchScanSummary = z.infer<typeof BatchScanSummarySchema>;
export type GetBatchResponse = z.infer<typeof GetBatchResponseSchema>;
