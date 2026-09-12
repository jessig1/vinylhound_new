import { z } from "zod";

/**
 * Discovery is deliberately a separate contract surface from `catalog.ts`.
 *
 * The catalog provider (MusicBrainz) answers "which pressing is this?" and
 * feeds scan review and the `confirmed_releases` rows behind the inventory.
 * Discovery answers "what music exists?" — browsing, artwork, discographies —
 * and its provider (Spotify) models streaming albums, not physical editions.
 * Keeping the two apart stops Spotify's richer browse data from being mistaken
 * for pressing evidence anywhere downstream (ADR-0019).
 */
export const DiscoveryProviderSchema = z.literal("spotify");

export const DiscoverySearchTypeSchema = z.enum([
  "all",
  "artist",
  "album",
  "track",
]);

/** Spotify identifiers are 22-character base-62 strings. */
export const DiscoveryIdSchema = z.string().regex(/^[A-Za-z0-9]{22}$/);

export const DiscoveryArtistSchema = z
  .object({
    id: DiscoveryIdSchema,
    name: z.string().trim().min(1).max(255),
    imageUrl: z.url().nullable(),
    genres: z.array(z.string().trim().min(1).max(100)).max(20),
    popularity: z.number().int().min(0).max(100).nullable(),
    externalUrl: z.url(),
  })
  .strict();

export const DiscoveryAlbumTypeSchema = z.enum([
  "album",
  "single",
  "compilation",
]);

export const DiscoveryAlbumSchema = z
  .object({
    id: DiscoveryIdSchema,
    title: z.string().trim().min(1).max(255),
    artist: z.string().trim().min(1).max(500),
    artistIds: z.array(DiscoveryIdSchema).max(20),
    albumType: DiscoveryAlbumTypeSchema,
    releaseDate: z
      .string()
      .regex(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/)
      .nullable(),
    releaseYear: z.number().int().min(1000).max(2999).nullable(),
    totalTracks: z.number().int().nonnegative().nullable(),
    coverUrl: z.url().nullable(),
    externalUrl: z.url(),
  })
  .strict();

export const DiscoveryTrackSchema = z
  .object({
    id: DiscoveryIdSchema,
    title: z.string().trim().min(1).max(255),
    artist: z.string().trim().min(1).max(500),
    albumId: DiscoveryIdSchema.nullable(),
    albumTitle: z.string().trim().min(1).max(255).nullable(),
    coverUrl: z.url().nullable(),
    durationMs: z.number().int().positive().nullable(),
    trackNumber: z.number().int().positive().nullable(),
    discNumber: z.number().int().positive().nullable(),
    externalUrl: z.url(),
  })
  .strict();

export const DiscoverySearchResultsSchema = z
  .object({
    artists: z.array(DiscoveryArtistSchema).max(50),
    albums: z.array(DiscoveryAlbumSchema).max(50),
    tracks: z.array(DiscoveryTrackSchema).max(50),
  })
  .strict();

export const DiscoverySearchResponseSchema =
  DiscoverySearchResultsSchema.extend({
    query: z.string().trim().min(1).max(200),
    type: DiscoverySearchTypeSchema,
  }).strict();

/**
 * An album's own page: full track listing plus the two fields Spotify does
 * carry that survive into a saved record — the label string and the UPC/EAN.
 * Everything else a pressing needs (catalog number, country, format,
 * packaging) has no Spotify equivalent and is intentionally absent rather
 * than guessed at.
 */
export const DiscoveryAlbumDetailSchema = DiscoveryAlbumSchema.extend({
  label: z.string().trim().min(1).max(255).nullable(),
  barcode: z.string().trim().min(1).max(255).nullable(),
  genres: z.array(z.string().trim().min(1).max(100)).max(20),
  tracks: z.array(DiscoveryTrackSchema).max(200),
}).strict();

export const DiscoveryArtistDetailResponseSchema = z
  .object({
    artist: DiscoveryArtistSchema,
    albums: z.array(DiscoveryAlbumSchema).max(100),
  })
  .strict();

export const DiscoveryAlbumDetailResponseSchema = z
  .object({ album: DiscoveryAlbumDetailSchema })
  .strict();

export const DiscoverySearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    type: DiscoverySearchTypeSchema.default("all"),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict();

export type DiscoveryProvider = z.infer<typeof DiscoveryProviderSchema>;
export type DiscoverySearchType = z.infer<typeof DiscoverySearchTypeSchema>;
export type DiscoveryArtist = z.infer<typeof DiscoveryArtistSchema>;
export type DiscoveryAlbumType = z.infer<typeof DiscoveryAlbumTypeSchema>;
export type DiscoveryAlbum = z.infer<typeof DiscoveryAlbumSchema>;
export type DiscoveryTrack = z.infer<typeof DiscoveryTrackSchema>;
export type DiscoverySearchResults = z.infer<
  typeof DiscoverySearchResultsSchema
>;
export type DiscoverySearchResponse = z.infer<
  typeof DiscoverySearchResponseSchema
>;
export type DiscoveryAlbumDetail = z.infer<typeof DiscoveryAlbumDetailSchema>;
export type DiscoveryArtistDetailResponse = z.infer<
  typeof DiscoveryArtistDetailResponseSchema
>;
export type DiscoveryAlbumDetailResponse = z.infer<
  typeof DiscoveryAlbumDetailResponseSchema
>;
export type DiscoverySearchQuery = z.infer<typeof DiscoverySearchQuerySchema>;
