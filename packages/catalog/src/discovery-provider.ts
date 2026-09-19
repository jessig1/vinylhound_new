import type {
  DiscoveryAlbum,
  DiscoveryAlbumDetail,
  DiscoveryArtist,
  DiscoverySearchResults,
  DiscoverySearchType,
} from "@vinylhound/contracts";

export interface DiscoverySearchInput {
  query: string;
  type?: DiscoverySearchType;
  limit?: number;
  /**
   * The authenticated caller, threaded through every port method so a
   * remote implementation (P4.1 Task 2) can assert it to the discovery
   * service rather than the caller trusting a bare header. Unused by the
   * in-process adapter, which needs no per-user behavior today.
   */
  userId: string;
}

export interface GetDiscoveryArtistInput {
  artistId: string;
  userId: string;
}

export interface GetDiscoveryAlbumInput {
  albumId: string;
  userId: string;
}

/**
 * Browsing and artwork, kept separate from {@link CatalogProvider}.
 *
 * A discovery provider answers "what music exists?" and is free to be a
 * streaming catalogue. It is never consulted to establish which pressing a
 * user physically owns — that stays with the catalog provider, whose data
 * models physical editions (ADR-0019).
 */
export interface DiscoveryProvider {
  search(input: DiscoverySearchInput): Promise<DiscoverySearchResults>;
  getArtist(
    input: GetDiscoveryArtistInput,
  ): Promise<{ artist: DiscoveryArtist; albums: DiscoveryAlbum[] }>;
  getAlbum(input: GetDiscoveryAlbumInput): Promise<DiscoveryAlbumDetail>;
}

/** Shared by `apps/web`'s HTTP boundary and `apps/discovery` so the two never disagree on status mapping. */
export function discoveryProviderErrorStatus(
  category: DiscoveryProviderErrorCategory,
): number {
  if (category === "rate_limit") return 429;
  if (category === "not_found") return 404;
  if (category === "not_configured") return 503;
  return 502;
}

export type DiscoveryProviderErrorCategory =
  | "not_configured"
  | "rate_limit"
  | "provider_unavailable"
  | "invalid_response"
  | "not_found";

/** See {@link CATALOG_PROVIDER_ERROR_KIND} for why this brand exists. */
export const DISCOVERY_PROVIDER_ERROR_KIND =
  "vinylhound.discoveryProviderError";

export class DiscoveryProviderError extends Error {
  readonly errorKind = DISCOVERY_PROVIDER_ERROR_KIND;

  constructor(
    readonly category: DiscoveryProviderErrorCategory,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "DiscoveryProviderError";
  }
}

/**
 * Prefer this over `instanceof DiscoveryProviderError` anywhere the error
 * crosses a package boundary.
 */
export function isDiscoveryProviderError(
  value: unknown,
): value is DiscoveryProviderError {
  return (
    value instanceof Error &&
    (value as Partial<DiscoveryProviderError>).errorKind ===
      DISCOVERY_PROVIDER_ERROR_KIND
  );
}
