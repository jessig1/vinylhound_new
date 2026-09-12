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
    artistId: string,
  ): Promise<{ artist: DiscoveryArtist; albums: DiscoveryAlbum[] }>;
  getAlbum(albumId: string): Promise<DiscoveryAlbumDetail>;
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
