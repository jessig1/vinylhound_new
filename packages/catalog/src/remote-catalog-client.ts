import {
  GetCatalogReleaseResponseSchema,
  SearchCatalogReleasesResponseSchema,
  type CatalogReleaseCandidate,
  type CatalogReleaseDetail,
} from "@vinylhound/contracts";
import {
  formatServiceAuthHeader,
  signServiceRequest,
} from "@vinylhound/service-auth";

import {
  CatalogProviderError,
  type CatalogProvider,
  type CatalogProviderErrorCategory,
  type GetCatalogReleaseDetailsInput,
  type SearchCatalogReleasesInput,
} from "./catalog-provider.ts";
import { isRetryableCategory, readWireError } from "./remote-client-support.ts";

const CATALOG_ERROR_CATEGORIES = new Set<CatalogProviderErrorCategory>([
  "rate_limit",
  "provider_unavailable",
  "invalid_response",
  "not_found",
]);

export interface RemoteCatalogClientOptions {
  /** e.g. `http://discovery.internal:4001` — no trailing slash required. */
  baseUrl: string;
  sharedSecret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The staging/production implementation of {@link CatalogProvider} (ADR-0025,
 * P4.1 Task 2): calls the standalone `apps/discovery` service instead of
 * MusicBrainz directly. Every method signs a fresh, short-lived token binding
 * the caller's `userId` (see `@vinylhound/service-auth`) rather than sending
 * it as a bare header. Errors are reconstructed as the same
 * {@link CatalogProviderError} the in-process adapter throws, so
 * `apps/web`'s HTTP error mapping needs no changes regardless of which
 * implementation `apps/web/src/server/context.ts` wires up.
 */
export function createRemoteCatalogClient(
  options: RemoteCatalogClientOptions,
): CatalogProvider {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function call(path: string, userId: string): Promise<unknown> {
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
      throw new CatalogProviderError(
        "provider_unavailable",
        true,
        "The discovery service could not be reached.",
      );
    }
    if (!response.ok) {
      throw await toCatalogProviderError(response);
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new CatalogProviderError(
        "invalid_response",
        false,
        "The discovery service returned a malformed response.",
      );
    }
  }

  return {
    async searchReleases(
      input: SearchCatalogReleasesInput,
    ): Promise<CatalogReleaseCandidate[]> {
      const params = new URLSearchParams({
        artist: input.artist,
        title: input.title,
      });
      if (input.limit !== undefined) {
        params.set("limit", String(input.limit));
      }
      const payload = await call(
        `/internal/v1/catalog/releases?${params.toString()}`,
        input.userId,
      );
      const parsed = SearchCatalogReleasesResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new CatalogProviderError(
          "invalid_response",
          false,
          "The discovery service's search response did not match the expected schema.",
        );
      }
      return parsed.data.results;
    },

    async getReleaseDetails(
      input: GetCatalogReleaseDetailsInput,
    ): Promise<CatalogReleaseDetail> {
      const payload = await call(
        `/internal/v1/catalog/releases/${encodeURIComponent(input.releaseId)}`,
        input.userId,
      );
      const parsed = GetCatalogReleaseResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new CatalogProviderError(
          "invalid_response",
          false,
          "The discovery service's release response did not match the expected schema.",
        );
      }
      return parsed.data.release;
    },
  };
}

async function toCatalogProviderError(
  response: Response,
): Promise<CatalogProviderError> {
  const wireError = await readWireError(response);
  const category = wireError?.code.startsWith("catalog_")
    ? wireError.code.slice("catalog_".length)
    : null;
  if (
    category &&
    CATALOG_ERROR_CATEGORIES.has(category as CatalogProviderErrorCategory)
  ) {
    const resolved = category as CatalogProviderErrorCategory;
    return new CatalogProviderError(
      resolved,
      isRetryableCategory(resolved),
      wireError?.message ?? `The discovery service reported ${resolved}.`,
    );
  }
  return new CatalogProviderError(
    "provider_unavailable",
    true,
    `The discovery service answered with an unexpected status (${response.status}).`,
  );
}
