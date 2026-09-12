import { z } from "zod";

export const CatalogProviderSchema = z.enum(["musicbrainz", "spotify"]);

/** MusicBrainz identifiers are MBIDs: permanent UUIDs. */
const MusicBrainzIdSchema = z.string().uuid();

/** Spotify identifiers are 22-character base-62 strings, never UUIDs. */
const SpotifyIdSchema = z.string().regex(/^[A-Za-z0-9]{22}$/);

/**
 * A provider's handle on an album concept and, where the provider models one,
 * a specific pressing.
 *
 * `releaseGroupId` always identifies the album concept. `releaseId` identifies
 * one physical pressing of it and is **null whenever the provider has no
 * pressing entity at all** — which is the case for every Spotify reference,
 * since Spotify catalogues streaming albums rather than physical editions.
 * A null `releaseId` is therefore not missing data to be backfilled later; it
 * is the machine-readable statement that this provider cannot establish which
 * pressing a user holds, matching the product rule that a cover or title match
 * identifies a release concept and never proves a pressing.
 */
export const CatalogReferenceSchema = z
  .object({
    provider: CatalogProviderSchema,
    releaseGroupId: z.string().trim().min(1).max(255),
    releaseId: z.string().trim().min(1).max(255).nullable(),
    sourceUrl: z.url(),
    fetchedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.provider === "musicbrainz") {
      if (!MusicBrainzIdSchema.safeParse(value.releaseGroupId).success) {
        context.addIssue({
          code: "custom",
          path: ["releaseGroupId"],
          message: "A MusicBrainz release group ID must be an MBID.",
        });
      }
      // MusicBrainz models pressings explicitly, so a reference that omitted
      // the release would be losing identity the provider actually supplies.
      if (
        value.releaseId === null ||
        !MusicBrainzIdSchema.safeParse(value.releaseId).success
      ) {
        context.addIssue({
          code: "custom",
          path: ["releaseId"],
          message: "A MusicBrainz reference must carry a release MBID.",
        });
      }
      return;
    }

    if (!SpotifyIdSchema.safeParse(value.releaseGroupId).success) {
      context.addIssue({
        code: "custom",
        path: ["releaseGroupId"],
        message: "A Spotify album ID must be 22 base-62 characters.",
      });
    }
    if (value.releaseId !== null) {
      context.addIssue({
        code: "custom",
        path: ["releaseId"],
        message: "Spotify has no pressing entity, so releaseId must be null.",
      });
    }
  });

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
