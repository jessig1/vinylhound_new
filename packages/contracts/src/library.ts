import { z } from "zod";

import { CatalogReferenceSchema } from "./catalog.ts";

export const LibraryListSchema = z.enum(["collection", "wishlist"]);
export type LibraryList = z.infer<typeof LibraryListSchema>;

export const LibrarySortSchema = z.enum(["recent", "artist", "title"]);
export type LibrarySort = z.infer<typeof LibrarySortSchema>;

export const LIBRARY_SEARCH_QUERY_MAX_LENGTH = 200;

export const LibraryQuerySchema = z
  .object({
    list: LibraryListSchema,
    q: z
      .string()
      .trim()
      .max(LIBRARY_SEARCH_QUERY_MAX_LENGTH)
      .optional()
      .transform((value) => (value ? value : undefined)),
    sort: LibrarySortSchema.optional().default("recent"),
  })
  .strict();
export type LibraryQuery = z.infer<typeof LibraryQuerySchema>;

export const RecordConditionSchema = z.enum([
  "mint",
  "near_mint",
  "very_good_plus",
  "very_good",
  "good_plus",
  "good",
  "fair",
  "poor",
]);

export const CopyDetailsInputSchema = z
  .object({
    mediaCondition: RecordConditionSchema.nullable().default(null),
    sleeveCondition: RecordConditionSchema.nullable().default(null),
    location: z.string().trim().min(1).max(255).nullable().default(null),
    notes: z.string().trim().max(2_000).nullable().default(null),
    acquiredAt: z.iso.date().nullable().default(null),
  })
  .strict();

/**
 * The reviewed release fields a user commits to, shared by the two ways a
 * record enters the library: confirming a scan, and placing a catalog result
 * directly from `/discover` with no scan involved. Keeping one shape means a
 * saved record carries identical fields whichever door it came through.
 */
const ReviewedReleaseShape = {
  artist: z.string().trim().min(1).max(255),
  title: z.string().trim().min(1).max(255),
  releaseYear: z.number().int().min(1900).max(2200).nullable(),
  label: z.string().trim().min(1).max(255).nullable(),
  catalogNumber: z.string().trim().min(1).max(255).nullable(),
  barcode: z.string().trim().min(1).max(255).nullable(),
  releaseDate: z
    .string()
    .regex(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/)
    .nullable()
    .default(null),
  country: z.string().trim().min(1).max(10).nullable().default(null),
  format: z.string().trim().min(1).max(255).nullable().default(null),
  packaging: z.string().trim().min(1).max(255).nullable().default(null),
  releaseStatus: z.string().trim().min(1).max(100).nullable().default(null),
  catalogReference: CatalogReferenceSchema.nullable().default(null),
  list: LibraryListSchema,
  notes: z.string().trim().max(2_000).nullable(),
  copy: CopyDetailsInputSchema.nullable().default(null),
};

function rejectWishlistCopy(
  value: { list: LibraryList; copy: unknown },
  context: z.RefinementCtx,
) {
  if (value.list === "wishlist" && value.copy !== null) {
    context.addIssue({
      code: "custom",
      path: ["copy"],
      message: "Wishlist entries cannot include an owned copy.",
    });
  }
}

export const ConfirmScanRequestSchema = z
  .object({
    selectedCandidateId: z.string().uuid().nullable(),
    ...ReviewedReleaseShape,
  })
  .strict()
  .superRefine(rejectWishlistCopy);

/**
 * Placing a release into the library straight from discovery. Identical to a
 * scan confirmation minus the scan: there is no candidate to select and no
 * image history, so none is invented — the saved record's
 * `confirmedFromScanId` stays null and no `scan_confirmations` audit row is
 * written, because no scan was reviewed.
 */
export const PlaceLibraryReleaseSchema = z
  .object(ReviewedReleaseShape)
  .strict()
  .superRefine(rejectWishlistCopy);

export const ConfirmedReleaseSchema = z
  .object({
    id: z.string().uuid(),
    artist: z.string().min(1),
    title: z.string().min(1),
    releaseYear: z.number().int().nullable(),
    label: z.string().nullable(),
    catalogNumber: z.string().nullable(),
    barcode: z.string().nullable(),
    releaseDate: z.string().nullable(),
    country: z.string().nullable(),
    format: z.string().nullable(),
    packaging: z.string().nullable(),
    releaseStatus: z.string().nullable(),
    catalogReference: CatalogReferenceSchema.nullable(),
  })
  .strict();

export const LibraryCopySchema = z
  .object({
    id: z.string().uuid(),
    mediaCondition: RecordConditionSchema.nullable(),
    sleeveCondition: RecordConditionSchema.nullable(),
    location: z.string().nullable(),
    notes: z.string().nullable(),
    acquiredAt: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const PlaceLibraryReleaseResponseSchema = z
  .object({
    release: ConfirmedReleaseSchema,
    libraryItem: z
      .object({
        id: z.string().uuid(),
        list: LibraryListSchema,
        notes: z.string().nullable(),
        copy: LibraryCopySchema.nullable(),
      })
      .strict(),
    placedAt: z.string().datetime(),
  })
  .strict();

export const UpdateLibraryCopySchema = z
  .object({
    mediaCondition: RecordConditionSchema.nullable().optional(),
    sleeveCondition: RecordConditionSchema.nullable().optional(),
    location: z.string().trim().min(1).max(255).nullable().optional(),
    notes: z.string().trim().max(2_000).nullable().optional(),
    acquiredAt: z.iso.date().nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value).length === 0) {
      context.addIssue({
        code: "custom",
        message: "Provide a copy field to update.",
      });
    }
  });

export const DeleteLibraryCopyResponseSchema = z
  .object({ id: z.string().uuid() })
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
        copy: LibraryCopySchema.nullable(),
      })
      .strict(),
    confirmedAt: z.string().datetime(),
  })
  .strict();

export const ConfirmScanResponseSchema = ScanConfirmationSummarySchema.extend({
  scanId: z.string().uuid(),
}).strict();

/**
 * Enough to request a signed read of the cover photo the item was confirmed
 * from, through the existing scan-scoped image endpoint. Null whenever the
 * item has no scan history or its scan kept no completed image.
 */
export const LibraryCoverImageSchema = z
  .object({
    scanId: z.string().uuid(),
    imageId: z.string().uuid(),
  })
  .strict();

export const LibraryItemResultSchema = z
  .object({
    id: z.string().uuid(),
    list: LibraryListSchema,
    notes: z.string().nullable(),
    release: ConfirmedReleaseSchema,
    copyCount: z.number().int().nonnegative(),
    copies: z.array(LibraryCopySchema).max(100),
    confirmedFromScanId: z.string().uuid().nullable(),
    coverImage: LibraryCoverImageSchema.nullable(),
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

export const UpdateLibraryItemSchema = z
  .object({
    list: LibraryListSchema.optional(),
    notes: z.string().trim().max(2_000).nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.list === undefined && value.notes === undefined) {
      context.addIssue({
        code: "custom",
        message: "At least one library item field must be provided.",
      });
    }
  });

export const UpdateLibraryItemResponseSchema = LibraryItemResultSchema;

export const DeleteLibraryItemResponseSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export type AddLibraryItem = z.infer<typeof AddLibraryItemSchema>;
export type UpdateLibraryItem = z.infer<typeof UpdateLibraryItemSchema>;
export type UpdateLibraryItemResponse = z.infer<
  typeof UpdateLibraryItemResponseSchema
>;
export type DeleteLibraryItemResponse = z.infer<
  typeof DeleteLibraryItemResponseSchema
>;
export type RecordCondition = z.infer<typeof RecordConditionSchema>;
export type CopyDetailsInput = z.infer<typeof CopyDetailsInputSchema>;
export type LibraryCopy = z.infer<typeof LibraryCopySchema>;
export type UpdateLibraryCopy = z.infer<typeof UpdateLibraryCopySchema>;
export type ConfirmScanRequest = z.infer<typeof ConfirmScanRequestSchema>;
export type ConfirmedRelease = z.infer<typeof ConfirmedReleaseSchema>;
export type ScanConfirmationSummary = z.infer<
  typeof ScanConfirmationSummarySchema
>;
export type ConfirmScanResponse = z.infer<typeof ConfirmScanResponseSchema>;
export type LibraryCoverImage = z.infer<typeof LibraryCoverImageSchema>;
export type LibraryItemResult = z.infer<typeof LibraryItemResultSchema>;
export type GetLibraryResponse = z.infer<typeof GetLibraryResponseSchema>;
export type PlaceLibraryRelease = z.infer<typeof PlaceLibraryReleaseSchema>;
export type PlaceLibraryReleaseResponse = z.infer<
  typeof PlaceLibraryReleaseResponseSchema
>;
