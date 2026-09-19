import {
  DiscoveryAlbumDetailResponseSchema,
  DiscoveryArtistDetailResponseSchema,
  DiscoverySearchResponseSchema,
  parseResponse,
  type DiscoveryAlbum,
  type DiscoveryAlbumDetail,
  type DiscoveryArtist,
  type DiscoverySearchResults,
} from "@vinylhound/contracts";
import {
  formatServiceAuthHeader,
  signServiceRequest,
} from "@vinylhound/service-auth";

import {
  DiscoveryProviderError,
  isDiscoveryProviderError,
  type DiscoveryProvider,
  type DiscoveryProviderErrorCategory,
  type DiscoverySearchInput,
  type GetDiscoveryAlbumInput,
  type GetDiscoveryArtistInput,
} from "./discovery-provider.ts";
import {
  callWithRetry,
  isRetryableCategory,
  readWireError,
} from "./remote-client-support.ts";

const DISCOVERY_ERROR_CATEGORIES = new Set<DiscoveryProviderErrorCategory>([
  "not_configured",
  "rate_limit",
  "provider_unavailable",
  "invalid_response",
  "not_found",
]);

export interface RemoteDiscoveryClientOptions {
  /** e.g. `http://discovery.internal:4001` — no trailing slash required. */
  baseUrl: string;
  sharedSecret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The staging/production implementation of {@link DiscoveryProvider}
 * (ADR-0025, P4.1 Task 2). See {@link createRemoteCatalogClient}'s doc
 * comment — the shape and reasoning are identical, just for Spotify instead
 * of MusicBrainz. In particular, "not configured" still means "this
 * deployment has no Spotify credentials" even though that fact now lives on
 * the discovery service rather than in this process's own config: the 503
 * `discovery_not_configured` response round-trips into the same
 * {@link DiscoveryProviderError} category either way, so `requireDiscovery`
 * and `apps/web`'s HTTP mapping behave identically regardless of which
 * implementation is wired up.
 */
export function createRemoteDiscoveryClient(
  options: RemoteDiscoveryClientOptions,
): DiscoveryProvider {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function callOnce(path: string, userId: string): Promise<unknown> {
    const token = signServiceRequest(options.sharedSecret, { userId });
    let response: Response;
    try {
      response = await request(`${baseUrl}${path}`, {
        headers: {
          authorization: formatServiceAuthHeader(token),
          accept: "application/json",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new DiscoveryProviderError(
        "provider_unavailable",
        true,
        "The discovery service could not be reached.",
      );
    }
    if (!response.ok) {
      throw await toDiscoveryProviderError(response);
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new DiscoveryProviderError(
        "invalid_response",
        false,
        "The discovery service returned a malformed response.",
      );
    }
  }

  // Bounded retry (P4.1 Task 5, ADR-0026): a single discovery replica can be
  // briefly unreachable across a stop-then-start deploy or pod eviction.
  function call(path: string, userId: string): Promise<unknown> {
    return callWithRetry(
      () => callOnce(path, userId),
      (error) => isDiscoveryProviderError(error) && error.retryable,
    );
  }

  return {
    async search(input: DiscoverySearchInput): Promise<DiscoverySearchResults> {
      const params = new URLSearchParams({ q: input.query });
      if (input.type) params.set("type", input.type);
      if (input.limit !== undefined) params.set("limit", String(input.limit));
      const payload = await call(
        `/internal/v1/discovery/search?${params.toString()}`,
        input.userId,
      );
      try {
        return parseResponse(DiscoverySearchResponseSchema, payload);
      } catch {
        throw new DiscoveryProviderError(
          "invalid_response",
          false,
          "The discovery service's search response did not match the expected schema.",
        );
      }
    },

    async getArtist(
      input: GetDiscoveryArtistInput,
    ): Promise<{ artist: DiscoveryArtist; albums: DiscoveryAlbum[] }> {
      const payload = await call(
        `/internal/v1/discovery/artists/${encodeURIComponent(input.artistId)}`,
        input.userId,
      );
      try {
        return parseResponse(DiscoveryArtistDetailResponseSchema, payload);
      } catch {
        throw new DiscoveryProviderError(
          "invalid_response",
          false,
          "The discovery service's artist response did not match the expected schema.",
        );
      }
    },

    async getAlbum(
      input: GetDiscoveryAlbumInput,
    ): Promise<DiscoveryAlbumDetail> {
      const payload = await call(
        `/internal/v1/discovery/albums/${encodeURIComponent(input.albumId)}`,
        input.userId,
      );
      try {
        return parseResponse(DiscoveryAlbumDetailResponseSchema, payload).album;
      } catch {
        throw new DiscoveryProviderError(
          "invalid_response",
          false,
          "The discovery service's album response did not match the expected schema.",
        );
      }
    },
  };
}

async function toDiscoveryProviderError(
  response: Response,
): Promise<DiscoveryProviderError> {
  const wireError = await readWireError(response);
  const category = wireError?.code.startsWith("discovery_")
    ? wireError.code.slice("discovery_".length)
    : null;
  if (
    category &&
    DISCOVERY_ERROR_CATEGORIES.has(category as DiscoveryProviderErrorCategory)
  ) {
    const resolved = category as DiscoveryProviderErrorCategory;
    return new DiscoveryProviderError(
      resolved,
      isRetryableCategory(resolved),
      wireError?.message ?? `The discovery service reported ${resolved}.`,
    );
  }
  return new DiscoveryProviderError(
    "provider_unavailable",
    true,
    `The discovery service answered with an unexpected status (${response.status}).`,
  );
}
