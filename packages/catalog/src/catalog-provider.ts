import type {
  CatalogReleaseCandidate,
  CatalogReleaseDetail,
} from "@vinylhound/contracts";

export interface SearchCatalogReleasesInput {
  artist: string;
  title: string;
  limit?: number;
}

export interface CatalogProvider {
  searchReleases(
    input: SearchCatalogReleasesInput,
  ): Promise<CatalogReleaseCandidate[]>;
  getReleaseDetails(releaseId: string): Promise<CatalogReleaseDetail>;
}

export type CatalogProviderErrorCategory =
  "rate_limit" | "provider_unavailable" | "invalid_response" | "not_found";

/**
 * Marks an error as this package's, independently of which copy of this
 * module created it. A bundler can place more than one instance of a
 * workspace package into an application's module graph, and when it does,
 * `instanceof` across the package boundary silently returns false and the
 * error is misclassified — a 500 instead of the status it should carry.
 * A branded field survives that, so classification never depends on module
 * identity. See `isCatalogProviderError`.
 */
export const CATALOG_PROVIDER_ERROR_KIND = "vinylhound.catalogProviderError";

export class CatalogProviderError extends Error {
  readonly errorKind = CATALOG_PROVIDER_ERROR_KIND;

  constructor(
    readonly category: CatalogProviderErrorCategory,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "CatalogProviderError";
  }
}

/**
 * Prefer this over `instanceof CatalogProviderError` anywhere the error
 * crosses a package boundary, such as `apps/web`'s HTTP error mapping.
 */
export function isCatalogProviderError(
  value: unknown,
): value is CatalogProviderError {
  return (
    value instanceof Error &&
    (value as Partial<CatalogProviderError>).errorKind ===
      CATALOG_PROVIDER_ERROR_KIND
  );
}
