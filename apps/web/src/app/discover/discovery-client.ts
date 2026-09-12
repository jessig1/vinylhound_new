import {
  DiscoveryAlbumDetailResponseSchema,
  DiscoveryArtistDetailResponseSchema,
  DiscoverySearchResponseSchema,
  type DiscoveryAlbumDetail,
  type DiscoveryArtist,
  type DiscoveryAlbum,
  type DiscoverySearchResponse,
  type DiscoverySearchType,
} from "@vinylhound/contracts";

/**
 * Discovery is optional per deployment, so a 503 is a normal answer rather
 * than a failure to log — the UI explains that the feature is not set up
 * instead of showing a generic error.
 */
export class DiscoveryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryUnavailableError";
  }
}

async function readJson(response: Response, fallbackMessage: string) {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };
  if (response.ok) return body;
  const message = body.error?.message ?? fallbackMessage;
  throw response.status === 503
    ? new DiscoveryUnavailableError(message)
    : new Error(message);
}

export async function searchDiscovery(
  query: string,
  options: { type?: DiscoverySearchType; limit?: number; signal?: AbortSignal },
): Promise<DiscoverySearchResponse> {
  const params = new URLSearchParams({ q: query });
  if (options.type) params.set("type", options.type);
  if (options.limit) params.set("limit", String(options.limit));
  const response = await fetch(`/api/v1/discovery/search?${params}`, {
    cache: "no-store",
    signal: options.signal,
  });
  return DiscoverySearchResponseSchema.parse(
    await readJson(response, "The search could not be completed."),
  );
}

export async function fetchDiscoveryArtist(
  artistId: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ artist: DiscoveryArtist; albums: DiscoveryAlbum[] }> {
  const response = await fetch(
    `/api/v1/discovery/artists/${encodeURIComponent(artistId)}`,
    { cache: "no-store", signal: options.signal },
  );
  return DiscoveryArtistDetailResponseSchema.parse(
    await readJson(response, "That artist could not be loaded."),
  );
}

export async function fetchDiscoveryAlbum(
  albumId: string,
  options: { signal?: AbortSignal } = {},
): Promise<DiscoveryAlbumDetail> {
  const response = await fetch(
    `/api/v1/discovery/albums/${encodeURIComponent(albumId)}`,
    { cache: "no-store", signal: options.signal },
  );
  return DiscoveryAlbumDetailResponseSchema.parse(
    await readJson(response, "That album could not be loaded."),
  ).album;
}

export function formatDuration(lengthMs: number) {
  const totalSeconds = Math.round(lengthMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

const tones = [
  "blue",
  "cream",
  "sun",
  "crosswalk",
  "classroom",
  "chrome",
  "ocean",
  "green",
  "snow",
  "red",
  "rainbow",
  "water",
] as const;

export function toneFor(id: string) {
  let value = 0;
  for (const character of id) value = (value + character.charCodeAt(0)) % 997;
  return tones[value % tones.length]!;
}
