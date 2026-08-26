import { z } from "zod";

export const LibraryListSchema = z.enum(["collection", "wishlist"]);
export type LibraryList = z.infer<typeof LibraryListSchema>;

export const ConfirmScanRequestSchema = z
  .object({
    selectedCandidateId: z.string().uuid().nullable(),
    artist: z.string().trim().min(1).max(255),
    title: z.string().trim().min(1).max(255),
    releaseYear: z.number().int().min(1900).max(2200).nullable(),
    label: z.string().trim().min(1).max(255).nullable(),
    catalogNumber: z.string().trim().min(1).max(255).nullable(),
    barcode: z.string().trim().min(1).max(255).nullable(),
    list: LibraryListSchema,
    notes: z.string().trim().max(2_000).nullable(),
  })
  .strict();

export const ConfirmedReleaseSchema = z
  .object({
    id: z.string().uuid(),
    artist: z.string().min(1),
    title: z.string().min(1),
    releaseYear: z.number().int().nullable(),
    label: z.string().nullable(),
    catalogNumber: z.string().nullable(),
    barcode: z.string().nullable(),
  })
  .strict();

export const ScanConfirmationSummarySchema = z
  .object({
    selectedCandidateId: z.string().uuid().nullable(),
    release: ConfirmedReleaseSchema,
    libraryItem: z
      .object({
        id: z.string().uuid(),
        list: LibraryListSchema,
        notes: z.string().nullable(),
      })
      .strict(),
    confirmedAt: z.string().datetime(),
  })
  .strict();

export const ConfirmScanResponseSchema = ScanConfirmationSummarySchema.extend({
  scanId: z.string().uuid(),
}).strict();

export const LibraryItemResultSchema = z
  .object({
    id: z.string().uuid(),
    list: LibraryListSchema,
    notes: z.string().nullable(),
    release: ConfirmedReleaseSchema,
    confirmedFromScanId: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const GetLibraryResponseSchema = z
  .object({
    list: LibraryListSchema,
    items: z.array(LibraryItemResultSchema).max(100),
  })
  .strict();

export const AddLibraryItemSchema = z
  .object({
    releaseId: z.string().uuid(),
    list: LibraryListSchema,
    notes: z.string().trim().max(2_000).nullable(),
  })
  .strict();

export type AddLibraryItem = z.infer<typeof AddLibraryItemSchema>;
export type ConfirmScanRequest = z.infer<typeof ConfirmScanRequestSchema>;
export type ConfirmedRelease = z.infer<typeof ConfirmedReleaseSchema>;
export type ScanConfirmationSummary = z.infer<
  typeof ScanConfirmationSummarySchema
>;
export type ConfirmScanResponse = z.infer<typeof ConfirmScanResponseSchema>;
export type LibraryItemResult = z.infer<typeof LibraryItemResultSchema>;
export type GetLibraryResponse = z.infer<typeof GetLibraryResponseSchema>;
