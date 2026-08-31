import { z } from "zod";

import {
  ImageMimeTypeSchema,
  ImageViewTypeSchema,
  MAX_IMAGES_PER_SCAN,
  MAX_IMAGE_SIZE_BYTES,
} from "./upload.js";
import { ScanConfirmationSummarySchema } from "./library.js";

export const IngestionSourceSchema = z.enum([
  "camera",
  "single_upload",
  "batch_upload",
]);

export const ScanStatusSchema = z.enum([
  "awaiting_upload",
  "queued",
  "processing",
  "identified",
  "needs_review",
  "unresolved",
  "failed",
  "canceled",
]);

export const RETRYABLE_SCAN_STATUSES = ["failed", "unresolved"] as const;

export const ScanAttemptStatusSchema = z.enum([
  "processing",
  "succeeded",
  "failed",
]);

export const ProviderErrorCategorySchema = z.enum([
  "timeout",
  "rate_limit",
  "provider_unavailable",
  "invalid_image",
  "refusal",
  "schema_invalid",
  "unknown",
]);

export const ReviewOutcomeReasonSchema = z.enum([
  "no_candidates",
  "provider_review_reason",
  "low_confidence",
  "ambiguous_candidates",
  "high_confidence_clear_lead",
]);

export const ImageAssetSchema = z
  .object({
    id: z.string().uuid(),
    objectKey: z.string().min(1),
    filename: z.string().min(1).max(255),
    viewType: ImageViewTypeSchema,
    mimeType: ImageMimeTypeSchema,
    sizeBytes: z.number().int().positive(),
  })
  .strict();

export const AlbumCandidateSchema = z
  .object({
    artist: z.string().trim().min(1),
    title: z.string().trim().min(1),
    releaseYear: z.number().int().min(1900).max(2200).nullable(),
    label: z.string().trim().min(1).nullable(),
    catalogNumber: z.string().trim().min(1).nullable(),
    barcode: z.string().trim().min(1).nullable(),
    confidence: z.number().min(0).max(1),
    evidence: z.array(z.string().trim().min(1)).max(10),
    warnings: z.array(z.string().trim().min(1)).max(10),
  })
  .strict();

export const AlbumIdentificationSchema = z
  .object({
    candidates: z.array(AlbumCandidateSchema).max(5),
    observations: z.array(z.string().trim().min(1)).max(10),
    needsReviewReasons: z.array(z.string().trim().min(1)).max(10),
  })
  .strict();

export const AnalyzeScanJobSchema = z
  .object({
    jobVersion: z.literal(1),
    scanId: z.string().uuid(),
    userId: z.string().uuid(),
    attemptNumber: z.number().int().positive(),
    imageIds: z
      .array(z.string().uuid())
      .min(1)
      .max(MAX_IMAGES_PER_SCAN)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Image IDs must be unique.",
      }),
    requestedAt: z.string().datetime(),
  })
  .strict();

export const ANALYZE_SCAN_JOB = "scan.analyze.v1" as const;

export type IngestionSource = z.infer<typeof IngestionSourceSchema>;
export type ScanStatus = z.infer<typeof ScanStatusSchema>;
export type ScanAttemptStatus = z.infer<typeof ScanAttemptStatusSchema>;
export type ProviderErrorCategory = z.infer<typeof ProviderErrorCategorySchema>;
export type ReviewOutcomeReason = z.infer<typeof ReviewOutcomeReasonSchema>;
export type ImageAsset = z.infer<typeof ImageAssetSchema>;
export type AlbumCandidate = z.infer<typeof AlbumCandidateSchema>;
export type AlbumIdentification = z.infer<typeof AlbumIdentificationSchema>;
export type AnalyzeScanJob = z.infer<typeof AnalyzeScanJobSchema>;

export const CreateScanRequestSchema = z
  .object({
    source: IngestionSourceSchema,
    batchId: z.string().uuid().optional(),
  })
  .strict();

export const CreateScanResponseSchema = z
  .object({
    scanId: z.string().uuid(),
    status: z.literal("awaiting_upload"),
    limits: z
      .object({
        acceptedMimeTypes: z.array(ImageMimeTypeSchema),
        maxImages: z.literal(MAX_IMAGES_PER_SCAN),
        maxImageSizeBytes: z.literal(MAX_IMAGE_SIZE_BYTES),
      })
      .strict(),
  })
  .strict();

export const SubmitScanResponseSchema = z
  .object({
    scanId: z.string().uuid(),
    status: z.literal("queued"),
    attemptNumber: z.number().int().positive(),
    jobId: z.string().min(1).max(255),
  })
  .strict();

export const RetryScanResponseSchema = z
  .object({
    scanId: z.string().uuid(),
    status: z.literal("queued"),
    attemptNumber: z.number().int().positive(),
    jobId: z.string().min(1).max(255),
  })
  .strict();

export const CancelScanResponseSchema = z
  .object({
    scanId: z.string().uuid(),
    status: z.literal("canceled"),
  })
  .strict();

export const ScanCandidateResultSchema = AlbumCandidateSchema.extend({
  id: z.string().uuid(),
  rank: z.number().int().positive(),
}).strict();

export const ScanImageSummarySchema = z
  .object({
    id: z.string().uuid(),
    filename: z.string().min(1).max(255),
    viewType: ImageViewTypeSchema,
    mimeType: ImageMimeTypeSchema,
  })
  .strict();

export const ScanAttemptSummarySchema = z
  .object({
    attemptNumber: z.number().int().positive(),
    deliveryAttempt: z.number().int().positive(),
    status: ScanAttemptStatusSchema,
    model: z.string().min(1),
    promptVersion: z.string().min(1),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        totalTokens: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    error: z
      .object({
        category: ProviderErrorCategorySchema,
        message: z.string().min(1),
      })
      .strict()
      .nullable(),
    observations: z.array(z.string().min(1)).max(10),
    needsReviewReasons: z.array(z.string().min(1)).max(10),
    outcomeReason: ReviewOutcomeReasonSchema.nullable(),
  })
  .strict();

export const GetScanResponseSchema = z
  .object({
    scanId: z.string().uuid(),
    batchId: z.string().uuid().nullable(),
    source: IngestionSourceSchema,
    status: ScanStatusSchema,
    createdAt: z.string().datetime(),
    submittedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    images: z.array(ScanImageSummarySchema).max(MAX_IMAGES_PER_SCAN),
    attempt: ScanAttemptSummarySchema.nullable(),
    candidates: z.array(ScanCandidateResultSchema).max(5),
    confirmation: ScanConfirmationSummarySchema.nullable(),
  })
  .strict();

export const MAX_SCANS_PER_PAGE = 50;

export const ScanListItemSchema = z
  .object({
    scanId: z.string().uuid(),
    batchId: z.string().uuid().nullable(),
    status: ScanStatusSchema,
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    topCandidate: ScanCandidateResultSchema.nullable(),
  })
  .strict();

export const ListScansResponseSchema = z
  .object({
    scans: z.array(ScanListItemSchema).max(MAX_SCANS_PER_PAGE),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const UsageCostSummarySchema = z
  .object({
    attemptCount: z.number().int().nonnegative(),
    totalInputTokens: z.number().int().nonnegative(),
    totalOutputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().nonnegative().nullable(),
    averageDurationMs: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type CreateScanRequest = z.infer<typeof CreateScanRequestSchema>;
export type CreateScanResponse = z.infer<typeof CreateScanResponseSchema>;
export type SubmitScanResponse = z.infer<typeof SubmitScanResponseSchema>;
export type RetryScanResponse = z.infer<typeof RetryScanResponseSchema>;
export type CancelScanResponse = z.infer<typeof CancelScanResponseSchema>;
export type ScanCandidateResult = z.infer<typeof ScanCandidateResultSchema>;
export type ScanImageSummary = z.infer<typeof ScanImageSummarySchema>;
export type ScanAttemptSummary = z.infer<typeof ScanAttemptSummarySchema>;
export type GetScanResponse = z.infer<typeof GetScanResponseSchema>;
export type ScanListItem = z.infer<typeof ScanListItemSchema>;
export type ListScansResponse = z.infer<typeof ListScansResponseSchema>;
export type UsageCostSummary = z.infer<typeof UsageCostSummarySchema>;
