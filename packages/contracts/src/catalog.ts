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

export type CatalogProvider = z.infer<typeof CatalogProviderSchema>;
export type CatalogReference = z.infer<typeof CatalogReferenceSchema>;
export type CatalogReleaseCandidate = z.infer<
  typeof CatalogReleaseCandidateSchema
>;
export type SearchCatalogReleasesResponse = z.infer<
  typeof SearchCatalogReleasesResponseSchema
>;
