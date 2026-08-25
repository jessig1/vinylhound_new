import { z } from "zod";

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

export const ImageAssetSchema = z
  .object({
    id: z.string().uuid(),
    objectKey: z.string().min(1),
    filename: z.string().min(1).max(255),
    mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
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
    imageIds: z.array(z.string().uuid()).min(1).max(12),
    requestedAt: z.string().datetime(),
  })
  .strict();

export type IngestionSource = z.infer<typeof IngestionSourceSchema>;
export type ScanStatus = z.infer<typeof ScanStatusSchema>;
export type ImageAsset = z.infer<typeof ImageAssetSchema>;
export type AlbumCandidate = z.infer<typeof AlbumCandidateSchema>;
export type AlbumIdentification = z.infer<typeof AlbumIdentificationSchema>;
export type AnalyzeScanJob = z.infer<typeof AnalyzeScanJobSchema>;
