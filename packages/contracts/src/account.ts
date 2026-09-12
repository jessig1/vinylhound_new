import { z } from "zod";

import { IngestionSourceSchema, ScanStatusSchema } from "./scan.ts";
import { ImageMimeTypeSchema, ImageViewTypeSchema } from "./upload.ts";
import { LibraryListSchema, RecordConditionSchema } from "./library.ts";

export const AccountExportScanSchema = z
  .object({
    id: z.string().uuid(),
    batchId: z.string().uuid().nullable(),
    source: IngestionSourceSchema,
    status: ScanStatusSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    submittedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict();

export const AccountExportImageSchema = z
  .object({
    id: z.string().uuid(),
    scanId: z.string().uuid(),
    objectKey: z.string().min(1),
    filename: z.string().min(1),
    viewType: ImageViewTypeSchema,
    mimeType: ImageMimeTypeSchema,
    sizeBytes: z.number().int().positive(),
    checksumSha256: z.string().min(1),
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
  })
  .strict();

export const AccountExportAttemptSchema = z
  .object({
    id: z.string().uuid(),
    scanId: z.string().uuid(),
    attemptNumber: z.number().int().positive(),
    status: z.enum(["processing", "succeeded", "failed"]),
    model: z.string().min(1),
    promptVersion: z.string().min(1),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const AccountExportConfirmationSchema = z
  .object({
    scanId: z.string().uuid(),
    // Null once the saved record this decision produced was removed
    // (ADR-0018). The decision itself is still the user's data and is
    // exported, so both the item reference and its list can be absent.
    libraryItemId: z.string().uuid().nullable(),
    releaseId: z.string().uuid(),
    artist: z.string().min(1),
    title: z.string().min(1),
    list: LibraryListSchema.nullable(),
    confirmedAt: z.string().datetime(),
  })
  .strict();

export const AccountExportLibraryItemSchema = z
  .object({
    id: z.string().uuid(),
    releaseId: z.string().uuid(),
    list: LibraryListSchema,
    notes: z.string().nullable(),
    confirmedFromScanId: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const AccountExportLibraryCopySchema = z
  .object({
    id: z.string().uuid(),
    libraryItemId: z.string().uuid(),
    releaseId: z.string().uuid(),
    mediaCondition: RecordConditionSchema.nullable(),
    sleeveCondition: RecordConditionSchema.nullable(),
    location: z.string().nullable(),
    notes: z.string().nullable(),
    acquiredAt: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const AccountExportBatchSchema = z
  .object({
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
  })
  .strict();

export const AccountExportResponseSchema = z
  .object({
    exportedAt: z.string().datetime(),
    account: z
      .object({
        id: z.string().uuid(),
        createdAt: z.string().datetime(),
      })
      .strict(),
    batches: z.array(AccountExportBatchSchema),
    scans: z.array(AccountExportScanSchema),
    images: z.array(AccountExportImageSchema),
    attempts: z.array(AccountExportAttemptSchema),
    confirmations: z.array(AccountExportConfirmationSchema),
    libraryItems: z.array(AccountExportLibraryItemSchema),
    libraryCopies: z.array(AccountExportLibraryCopySchema),
  })
  .strict();

export const DeleteAccountResponseSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export type AccountExportResponse = z.infer<typeof AccountExportResponseSchema>;
export type DeleteAccountResponse = z.infer<typeof DeleteAccountResponseSchema>;
