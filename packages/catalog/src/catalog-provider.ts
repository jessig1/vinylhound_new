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

export class CatalogProviderError extends Error {
  constructor(
    readonly category: CatalogProviderErrorCategory,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "CatalogProviderError";
  }
}
