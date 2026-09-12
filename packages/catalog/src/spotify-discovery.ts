import { z } from "zod";

import {
  DiscoveryAlbumDetailSchema,
  DiscoveryAlbumSchema,
  DiscoveryArtistSchema,
  DiscoverySearchResultsSchema,
  DiscoveryTrackSchema,
  type DiscoveryAlbum,
  type DiscoveryAlbumDetail,
  type DiscoveryArtist,
  type DiscoverySearchResults,
  type DiscoveryTrack,
} from "@vinylhound/contracts";

import {
  DiscoveryProviderError,
  type DiscoveryProvider,
  type DiscoverySearchInput,
} from "./discovery-provider.ts";

const SpotifyIdSchema = z.string().regex(/^[A-Za-z0-9]{22}$/);

const SpotifyImageSchema = z
  .object({
    url: z.string().min(1),
    height: z.number().int().positive().nullable().optional(),
    width: z.number().int().positive().nullable().optional(),
  })
  .passthrough();

const SpotifyArtistRefSchema = z
  .object({
    id: z.string().min(1).nullable().optional(),
    name: z.string().min(1),
  })
  .passthrough();

const SpotifyExternalUrlsSchema = z
  .object({ spotify: z.string().min(1).optional() })
  .passthrough();

const SpotifyArtistSchema = z
  .object({
    id: SpotifyIdSchema,
    name: z.string().min(1),
    images: z.array(SpotifyImageSchema).optional(),
    genres: z.array(z.string().min(1)).optional(),
    popularity: z.number().int().min(0).max(100).optional(),
    external_urls: SpotifyExternalUrlsSchema.optional(),
  })
  .passthrough();

const SpotifyAlbumSchema = z
  .object({
    id: SpotifyIdSchema,
    name: z.string().min(1),
    album_type: z.string().min(1).optional(),
    artists: z.array(SpotifyArtistRefSchema).optional(),
    images: z.array(SpotifyImageSchema).optional(),
    release_date: z.string().optional(),
    total_tracks: z.number().int().nonnegative().optional(),
    external_urls: SpotifyExternalUrlsSchema.optional(),
  })
  .passthrough();

const SpotifyTrackSchema = z
  .object({
    id: SpotifyIdSchema,
    name: z.string().min(1),
    artists: z.array(SpotifyArtistRefSchema).optional(),
    album: SpotifyAlbumSchema.partial({ id: true }).optional(),
    duration_ms: z.number().int().nonnegative().optional(),
    track_number: z.number().int().positive().optional(),
    disc_number: z.number().int().positive().optional(),
    external_urls: SpotifyExternalUrlsSchema.optional(),
  })
  .passthrough();

/**
 * Spotify occasionally returns `null` entries inside paging arrays (most often
 * for regionally unavailable items). Every list is parsed as nullable so one
 * bad entry degrades to a shorter result list rather than failing the request.
 */
function nullableItems<Schema extends z.ZodTypeAny>(schema: Schema) {
  return z
    .object({ items: z.array(schema.nullable()).optional() })
    .passthrough();
}

const SpotifySearchResponseSchema = z
  .object({
    artists: nullableItems(SpotifyArtistSchema).optional(),
    albums: nullableItems(SpotifyAlbumSchema).optional(),
    tracks: nullableItems(SpotifyTrackSchema).optional(),
  })
  .passthrough();

const SpotifyAlbumDetailSchema = SpotifyAlbumSchema.extend({
  label: z.string().min(1).nullable().optional(),
  genres: z.array(z.string().min(1)).optional(),
  external_ids: z
    .object({
      upc: z.string().min(1).nullable().optional(),
      ean: z.string().min(1).nullable().optional(),
    })
    .passthrough()
    .optional(),
  tracks: nullableItems(SpotifyTrackSchema).optional(),
}).passthrough();

const SpotifyArtistAlbumsSchema = nullableItems(SpotifyAlbumSchema);

const SpotifyTokenSchema = z
  .object({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive(),
  })
  .passthrough();

export interface SpotifyDiscoveryOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  accountsUrl?: string;
  fetch?: typeof fetch;
  cacheTtlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export function createSpotifyDiscovery(
  options: SpotifyDiscoveryOptions,
): DiscoveryProvider {
  const baseUrl = (options.baseUrl ?? "https://api.spotify.com/v1").replace(
    /\/$/,
    "",
  );
  const accountsUrl =
    options.accountsUrl ?? "https://accounts.spotify.com/api/token";
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const cacheTtlMs = options.cacheTtlMs ?? 60 * 60 * 1_000;
  const cache = new Map<string, { expiresAt: number; value: unknown }>();

  let token: { value: string; expiresAt: number } | null = null;
  // Concurrent requests that all find the token expired must not each mint a
  // new one; the first refresh is shared by every caller waiting on it.
  let tokenRefresh: Promise<string> | null = null;

  async function mintToken(): Promise<string> {
    const credentials = Buffer.from(
      `${options.clientId}:${options.clientSecret}`,
    ).toString("base64");
    let response: Response;
    try {
      response = await request(accountsUrl, {
        method: "POST",
        headers: {
          authorization: `Basic ${credentials}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new DiscoveryProviderError(
        "provider_unavailable",
        true,
        "Spotify could not be reached.",
      );
    }
    if (!response.ok) {
      // 400/401 here means the configured credentials are wrong, which no
      // amount of retrying fixes.
      throw new DiscoveryProviderError(
        response.status === 400 || response.status === 401
          ? "not_configured"
          : "provider_unavailable",
        response.status !== 400 && response.status !== 401,
        response.status === 400 || response.status === 401
          ? "The configured Spotify credentials were rejected."
          : "Spotify could not issue an access token.",
      );
    }
    const parsed = SpotifyTokenSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new DiscoveryProviderError(
        "invalid_response",
        false,
        "Spotify returned an unexpected token response.",
      );
    }
    token = {
      value: parsed.data.access_token,
      // Refresh a minute early so a request never races the expiry boundary.
      expiresAt: now() + parsed.data.expires_in * 1_000 - 60_000,
    };
    return token.value;
  }

  async function accessToken(forceRefresh = false): Promise<string> {
    if (forceRefresh) {
      token = null;
      tokenRefresh = null;
    }
    if (token && token.expiresAt > now()) return token.value;
    tokenRefresh ??= mintToken().finally(() => {
      tokenRefresh = null;
    });
    return tokenRefresh;
  }

  async function callApi(path: string, params: URLSearchParams) {
    const url = `${baseUrl}${path}?${params.toString()}`;

    async function attempt(bearer: string) {
      try {
        return await request(url, {
          headers: {
            authorization: `Bearer ${bearer}`,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new DiscoveryProviderError(
          "provider_unavailable",
          true,
          "Spotify could not be reached.",
        );
      }
    }

    let response = await attempt(await accessToken());
    if (response.status === 401) {
      // The cached token was revoked or expired early; mint a fresh one once.
      response = await attempt(await accessToken(true));
    }

    if (response.status === 429) {
      throw new DiscoveryProviderError(
        "rate_limit",
        true,
        "Spotify is rate limiting requests. Try again shortly.",
      );
    }
    if (response.status === 404) {
      throw new DiscoveryProviderError(
        "not_found",
        false,
        "That Spotify record does not exist.",
      );
    }
    if (!response.ok) {
      // Spotify explains refusals in the body, and those explanations are
      // often the whole diagnosis — a 403 here means "the account that owns
      // this app needs an active Premium subscription", which no retry and no
      // credential change fixes. Losing that text turns a one-line answer into
      // an afternoon.
      const reason = await readFailureReason(response);
      if (response.status === 401 || response.status === 403) {
        throw new DiscoveryProviderError(
          "not_configured",
          false,
          reason
            ? `Spotify rejected this request: ${reason}`
            : "The configured Spotify credentials were rejected.",
        );
      }
      throw new DiscoveryProviderError(
        "provider_unavailable",
        true,
        reason
          ? `Spotify could not answer the request (${response.status}): ${reason}`
          : `Spotify could not answer the request (${response.status}).`,
      );
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new DiscoveryProviderError(
        "invalid_response",
        false,
        "Spotify returned a malformed response.",
      );
    }
  }

  async function cachedCall(
    cacheKey: string,
    path: string,
    params: URLSearchParams,
  ) {
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return cached.value;
    const value = await callApi(path, params);
    cache.set(cacheKey, { expiresAt: now() + cacheTtlMs, value });
    return value;
  }

  return {
    async search(input: DiscoverySearchInput): Promise<DiscoverySearchResults> {
      const query = input.query.trim();
      if (!query) {
        throw new TypeError("A discovery search needs a query.");
      }
      const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
      const type = input.type ?? "all";
      const types = type === "all" ? ["artist", "album", "track"] : [type];

      const params = new URLSearchParams({
        q: query,
        type: types.join(","),
        limit: String(limit),
      });
      const payload = await cachedCall(
        `search:${query.toLowerCase()}:${types.join(",")}:${limit}`,
        "/search",
        params,
      );
      const parsed = SpotifySearchResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new DiscoveryProviderError(
          "invalid_response",
          false,
          "Spotify returned an unexpected search response.",
        );
      }

      return DiscoverySearchResultsSchema.parse({
        artists: (parsed.data.artists?.items ?? []).flatMap((artist) =>
          artist ? toArtist(artist) : [],
        ),
        albums: (parsed.data.albums?.items ?? []).flatMap((album) =>
          album ? toAlbum(album) : [],
        ),
        tracks: (parsed.data.tracks?.items ?? []).flatMap((track) =>
          track ? toTrack(track, null) : [],
        ),
      } satisfies DiscoverySearchResults);
    },

    async getArtist(artistId: string) {
      const id = requireSpotifyId(artistId, "artist");
      const [artistPayload, albumsPayload] = await Promise.all([
        cachedCall(`artist:${id}`, `/artists/${id}`, new URLSearchParams()),
        cachedCall(
          `artist-albums:${id}`,
          `/artists/${id}/albums`,
          new URLSearchParams({
            include_groups: "album,single,compilation",
            limit: "50",
          }),
        ),
      ]);

      const parsedArtist = SpotifyArtistSchema.safeParse(artistPayload);
      const parsedAlbums = SpotifyArtistAlbumsSchema.safeParse(albumsPayload);
      if (!parsedArtist.success || !parsedAlbums.success) {
        throw new DiscoveryProviderError(
          "invalid_response",
          false,
          "Spotify returned an unexpected artist response.",
        );
      }
      const artist = toArtist(parsedArtist.data)[0];
      if (!artist) {
        throw new DiscoveryProviderError(
          "invalid_response",
          false,
          "Spotify returned an unexpected artist response.",
        );
      }

      const albums = dedupeAlbums(
        (parsedAlbums.data.items ?? []).flatMap((album) =>
          album ? toAlbum(album) : [],
        ),
      );
      return { artist, albums };
    },

    async getAlbum(albumId: string): Promise<DiscoveryAlbumDetail> {
      const id = requireSpotifyId(albumId, "album");
      const payload = await cachedCall(
        `album:${id}`,
        `/albums/${id}`,
        new URLSearchParams(),
      );
      const parsed = SpotifyAlbumDetailSchema.safeParse(payload);
      if (!parsed.success) {
        throw new DiscoveryProviderError(
          "invalid_response",
          false,
          "Spotify returned an unexpected album response.",
        );
      }
      const album = toAlbum(parsed.data)[0];
      if (!album) {
        throw new DiscoveryProviderError(
          "invalid_response",
          false,
          "Spotify returned an unexpected album response.",
        );
      }

      const cover = album.coverUrl;
      const tracks = (parsed.data.tracks?.items ?? []).flatMap((track) =>
        track
          ? toTrack(
              track,
              { id: album.id, title: album.title, coverUrl: cover },
              album.artist,
            )
          : [],
      );

      const detail = DiscoveryAlbumDetailSchema.safeParse({
        ...album,
        label: nonEmpty(parsed.data.label),
        barcode:
          nonEmpty(parsed.data.external_ids?.upc) ??
          nonEmpty(parsed.data.external_ids?.ean),
        genres: (parsed.data.genres ?? []).slice(0, 20),
        tracks: tracks.slice(0, 200),
      });
      if (!detail.success) {
        throw new DiscoveryProviderError(
          "invalid_response",
          false,
          "Spotify returned an unexpected album response.",
        );
      }
      return detail.data;
    },
  };
}

/**
 * Spotify returns either a JSON envelope (`{ error: { message } }`) or bare
 * text. Both are read defensively: a failure to parse the explanation must
 * never replace the original failure.
 */
async function readFailureReason(response: Response) {
  try {
    const text = (await response.text()).trim();
    if (!text) return null;
    try {
      const parsed: unknown = JSON.parse(text);
      const message =
        typeof parsed === "object" && parsed !== null
          ? ((parsed as { error?: { message?: unknown } }).error?.message ??
            (parsed as { error_description?: unknown }).error_description)
          : null;
      if (typeof message === "string" && message.trim()) {
        return message.trim().slice(0, 300);
      }
    } catch {
      // Not JSON; the raw text is the explanation.
    }
    return text.slice(0, 300);
  } catch {
    return null;
  }
}

function requireSpotifyId(value: string, label: string) {
  const parsed = SpotifyIdSchema.safeParse(value);
  if (!parsed.success) {
    // A malformed ID can never match a record, so it is answered locally
    // rather than spending a request to be told the same thing.
    throw new DiscoveryProviderError(
      "not_found",
      false,
      `That Spotify ${label} does not exist.`,
    );
  }
  return parsed.data;
}

function nonEmpty(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function spotifyUrl(
  external: { spotify?: string } | undefined,
  kind: "artist" | "album" | "track",
  id: string,
) {
  const url = external?.spotify?.trim();
  return url && url.startsWith("https://")
    ? url
    : `https://open.spotify.com/${kind}/${id}`;
}

function largestImage(images: { url: string }[] | undefined) {
  // Spotify orders images widest-first, so the head is the best available.
  const url = images?.[0]?.url?.trim();
  return url && url.startsWith("https://") ? url : null;
}

function joinArtists(artists: { name: string }[] | undefined) {
  const names = (artists ?? [])
    .map((artist) => artist.name.trim())
    .filter(Boolean);
  return names.length ? names.join(", ") : null;
}

/**
 * Spotify reports dates at year, month, or day precision, and occasionally
 * emits placeholders such as `0000`. Anything that is not a usable calendar
 * year is dropped rather than stored as a fact.
 */
function toReleaseDate(value: string | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(trimmed)) {
    return { releaseDate: null, releaseYear: null };
  }
  const year = Number.parseInt(trimmed.slice(0, 4), 10);
  if (!Number.isFinite(year) || year < 1000 || year > 2999) {
    return { releaseDate: null, releaseYear: null };
  }
  return { releaseDate: trimmed, releaseYear: year };
}

function toAlbumType(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "single" || normalized === "compilation"
    ? normalized
    : "album";
}

function toArtist(
  artist: z.infer<typeof SpotifyArtistSchema>,
): DiscoveryArtist[] {
  const parsed = DiscoveryArtistSchema.safeParse({
    id: artist.id,
    name: artist.name.trim(),
    imageUrl: largestImage(artist.images),
    genres: (artist.genres ?? []).slice(0, 20),
    popularity: artist.popularity ?? null,
    externalUrl: spotifyUrl(artist.external_urls, "artist", artist.id),
  });
  return parsed.success ? [parsed.data] : [];
}

function toAlbum(album: z.infer<typeof SpotifyAlbumSchema>): DiscoveryAlbum[] {
  const artist = joinArtists(album.artists);
  if (!artist) return [];
  const { releaseDate, releaseYear } = toReleaseDate(album.release_date);
  const parsed = DiscoveryAlbumSchema.safeParse({
    id: album.id,
    title: album.name.trim(),
    artist,
    artistIds: (album.artists ?? []).flatMap((entry) =>
      entry.id && SpotifyIdSchema.safeParse(entry.id).success ? [entry.id] : [],
    ),
    albumType: toAlbumType(album.album_type),
    releaseDate,
    releaseYear,
    totalTracks: album.total_tracks ?? null,
    coverUrl: largestImage(album.images),
    externalUrl: spotifyUrl(album.external_urls, "album", album.id),
  });
  return parsed.success ? [parsed.data] : [];
}

function toTrack(
  track: z.infer<typeof SpotifyTrackSchema>,
  album: { id: string; title: string; coverUrl: string | null } | null,
  fallbackArtist?: string,
): DiscoveryTrack[] {
  const artist = joinArtists(track.artists) ?? fallbackArtist ?? null;
  if (!artist) return [];
  // On an album page Spotify's simplified track objects omit `album`, so the
  // album being viewed is threaded in by the caller instead.
  const albumId = album?.id ?? track.album?.id ?? null;
  const albumTitle = album?.title ?? track.album?.name?.trim() ?? null;
  const coverUrl = album?.coverUrl ?? largestImage(track.album?.images);
  const parsed = DiscoveryTrackSchema.safeParse({
    id: track.id,
    title: track.name.trim(),
    artist,
    albumId:
      albumId && SpotifyIdSchema.safeParse(albumId).success ? albumId : null,
    albumTitle,
    coverUrl,
    durationMs: track.duration_ms ? track.duration_ms : null,
    trackNumber: track.track_number ?? null,
    discNumber: track.disc_number ?? null,
    externalUrl: spotifyUrl(track.external_urls, "track", track.id),
  });
  return parsed.success ? [parsed.data] : [];
}

/**
 * An artist's album list routinely repeats one album across markets. They are
 * collapsed on normalized title plus release year so a discography reads as a
 * discography rather than as the same record eight times.
 */
function dedupeAlbums(albums: DiscoveryAlbum[]) {
  const seen = new Map<string, DiscoveryAlbum>();
  for (const album of albums) {
    const key = `${album.albumType}:${album.title.toLowerCase()}:${album.releaseYear ?? ""}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, album);
      continue;
    }
    // Prefer the entry that carries artwork, then the one with more tracks.
    if (!existing.coverUrl && album.coverUrl) {
      seen.set(key, album);
    } else if ((album.totalTracks ?? 0) > (existing.totalTracks ?? 0)) {
      seen.set(key, album);
    }
  }
  return [...seen.values()].sort(
    (left, right) => (right.releaseYear ?? 0) - (left.releaseYear ?? 0),
  );
}
