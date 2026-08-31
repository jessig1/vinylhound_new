import type { CatalogReleaseCandidate } from "@vinylhound/contracts";

export interface SearchCatalogReleasesInput {
  artist: string;
  title: string;
  limit?: number;
}

export interface CatalogProvider {
  searchReleases(
    input: SearchCatalogReleasesInput,
  ): Promise<CatalogReleaseCandidate[]>;
}

export type CatalogProviderErrorCategory =
  "rate_limit" | "provider_unavailable" | "invalid_response";

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
