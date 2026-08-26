import { z } from "zod";

import {
  ImageMimeTypeSchema,
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
]);

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

export const ScanCandidateResultSchema = AlbumCandidateSchema.extend({
  id: z.string().uuid(),
  rank: z.number().int().positive(),
}).strict();

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
    source: IngestionSourceSchema,
    status: ScanStatusSchema,
    createdAt: z.string().datetime(),
    submittedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    attempt: ScanAttemptSummarySchema.nullable(),
    candidates: z.array(ScanCandidateResultSchema).max(5),
    confirmation: ScanConfirmationSummarySchema.nullable(),
  })
  .strict();

export type CreateScanRequest = z.infer<typeof CreateScanRequestSchema>;
export type CreateScanResponse = z.infer<typeof CreateScanResponseSchema>;
export type SubmitScanResponse = z.infer<typeof SubmitScanResponseSchema>;
export type ScanCandidateResult = z.infer<typeof ScanCandidateResultSchema>;
export type ScanAttemptSummary = z.infer<typeof ScanAttemptSummarySchema>;
export type GetScanResponse = z.infer<typeof GetScanResponseSchema>;
