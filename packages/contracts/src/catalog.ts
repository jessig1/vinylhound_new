import { z } from "zod";

export const CatalogProviderSchema = z.literal("musicbrainz");

export const CatalogReferenceSchema = z
  .object({
    provider: CatalogProviderSchema,
    releaseGroupId: z.string().uuid(),
    releaseId: z.string().uuid(),
    sourceUrl: z.url(),
    fetchedAt: z.string().datetime(),
  })
  .strict();

export const CatalogLabelSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    catalogNumber: z.string().trim().min(1).max(255).nullable(),
  })
  .strict();

export const CatalogReleaseCandidateSchema = z
  .object({
    reference: CatalogReferenceSchema,
    artist: z.string().trim().min(1).max(255),
    title: z.string().trim().min(1).max(255),
    releaseDate: z
      .string()
      .regex(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/)
      .nullable(),
    country: z.string().trim().min(1).max(10).nullable(),
    labels: z.array(CatalogLabelSchema).max(20),
    barcode: z.string().trim().min(1).max(255).nullable(),
    formats: z.array(z.string().trim().min(1).max(255)).max(20),
    packaging: z.string().trim().min(1).max(255).nullable(),
    status: z.string().trim().min(1).max(100).nullable(),
    score: z.number().int().min(0).max(100),
  })
  .strict();

export const SearchCatalogReleasesResponseSchema = z
  .object({
    results: z.array(CatalogReleaseCandidateSchema).max(25),
  })
  .strict();

export const CatalogTrackSchema = z
  .object({
    position: z.string().trim().min(1).max(20),
    title: z.string().trim().min(1).max(255),
    lengthMs: z.number().int().positive().nullable(),
  })
  .strict();

/**
 * A single pressing's full detail. `reference.releaseGroupId` identifies the
 * album concept shared by every pressing; `reference.releaseId` identifies
 * this specific pressing. `releaseGroupTitle` is the release group's own
 * title so the UI can show when a pressing's title diverges from the concept
 * it belongs to (reissue subtitles, regional retitling, and similar).
 */
export const CatalogReleaseDetailSchema = CatalogReleaseCandidateSchema.extend({
  releaseGroupTitle: z.string().trim().min(1).max(255),
  tracks: z.array(CatalogTrackSchema).max(200),
}).strict();

export const GetCatalogReleaseResponseSchema = z
  .object({
    release: CatalogReleaseDetailSchema,
  })
  .strict();

export type CatalogProvider = z.infer<typeof CatalogProviderSchema>;
export type CatalogReference = z.infer<typeof CatalogReferenceSchema>;
export type CatalogReleaseCandidate = z.infer<
  typeof CatalogReleaseCandidateSchema
>;
export type SearchCatalogReleasesResponse = z.infer<
  typeof SearchCatalogReleasesResponseSchema
>;
export type CatalogTrack = z.infer<typeof CatalogTrackSchema>;
export type CatalogReleaseDetail = z.infer<typeof CatalogReleaseDetailSchema>;
export type GetCatalogReleaseResponse = z.infer<
  typeof GetCatalogReleaseResponseSchema
>;
