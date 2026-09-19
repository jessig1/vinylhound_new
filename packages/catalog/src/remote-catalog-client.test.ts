import { describe, expect, it, vi } from "vitest";

import { verifyServiceRequest } from "@vinylhound/service-auth";

import { createRemoteCatalogClient } from "./remote-catalog-client.ts";

const SECRET = "correct-horse-battery-staple-correct-horse";
const BASE_URL = "http://discovery.internal:4001";
const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const releaseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const releaseGroupId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const candidate = {
  reference: {
    provider: "musicbrainz" as const,
    releaseGroupId,
    releaseId,
    sourceUrl: `https://musicbrainz.org/release/${releaseId}`,
    fetchedAt: "2026-09-18T12:00:00.000Z",
  },
  artist: "Miles Davis",
  title: "Kind of Blue",
  releaseDate: "1959-08-17",
  country: "US",
  labels: [],
  barcode: null,
  formats: ['12" Vinyl'],
  packaging: null,
  status: null,
  score: 98,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createRemoteCatalogClient", () => {
  it("signs every request with a valid, user-bound service auth token", async () => {
    const request = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const header = (init?.headers as Record<string, string>).authorization;
        const token = header.replace(/^Bearer /, "");
        expect(verifyServiceRequest(SECRET, token)).toEqual({ userId });
        return jsonResponse({ results: [candidate] });
      },
    );
    const client = createRemoteCatalogClient({
      baseUrl: BASE_URL,
      sharedSecret: SECRET,
      fetch: request as typeof fetch,
    });

    const results = await client.searchReleases({
      artist: "Miles Davis",
      title: "Kind of Blue",
      userId,
    });

    expect(results).toEqual([candidate]);
    expect(request).toHaveBeenCalledTimes(1);
    const [url] = request.mock.calls[0]!;
    expect(String(url)).toBe(
      `${BASE_URL}/internal/v1/catalog/releases?artist=Miles+Davis&title=Kind+of+Blue`,
    );
  });

  it("fetches release details from the release-id path", async () => {
    const request = vi.fn(async () =>
      jsonResponse({
        release: {
          ...candidate,
          releaseGroupTitle: "Kind of Blue",
          tracks: [],
        },
      }),
    );
    const client = createRemoteCatalogClient({
      baseUrl: BASE_URL,
      sharedSecret: SECRET,
      fetch: request as typeof fetch,
    });

    const detail = await client.getReleaseDetails({ releaseId, userId });

    expect(detail.releaseGroupTitle).toBe("Kind of Blue");
    const [url] = request.mock.calls[0] as unknown as [RequestInfo | URL];
    expect(String(url)).toBe(
      `${BASE_URL}/internal/v1/catalog/releases/${releaseId}`,
    );
  });

  it("maps a wire error code back to the matching CatalogProviderError category", async () => {
    const request = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: "catalog_rate_limit",
            message: "Too many requests.",
            requestId: "11111111-1111-4111-8111-111111111111",
          },
        },
        429,
      ),
    );
    const client = createRemoteCatalogClient({
      baseUrl: BASE_URL,
      sharedSecret: SECRET,
      fetch: request as typeof fetch,
    });

    await expect(
      client.searchReleases({ artist: "a", title: "b", userId }),
    ).rejects.toMatchObject({ category: "rate_limit", retryable: true });
  });

  it("falls back to a retryable provider_unavailable for an unrecognized failure", async () => {
    const request = vi.fn(async () => new Response(null, { status: 500 }));
    const client = createRemoteCatalogClient({
      baseUrl: BASE_URL,
      sharedSecret: SECRET,
      fetch: request as typeof fetch,
    });

    await expect(
      client.searchReleases({ artist: "a", title: "b", userId }),
    ).rejects.toMatchObject({
      category: "provider_unavailable",
      retryable: true,
    });
  });

  it("maps a network failure to a retryable provider_unavailable", async () => {
    const request = vi.fn(async () => {
      throw new Error("network down");
    });
    const client = createRemoteCatalogClient({
      baseUrl: BASE_URL,
      sharedSecret: SECRET,
      fetch: request as typeof fetch,
    });

    await expect(
      client.searchReleases({ artist: "a", title: "b", userId }),
    ).rejects.toMatchObject({
      category: "provider_unavailable",
      retryable: true,
    });
  });

  it("retries a retryable failure and succeeds within the bound", async () => {
    let calls = 0;
    const request = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        return jsonResponse(
          {
            error: {
              code: "catalog_provider_unavailable",
              message: "Temporarily unreachable.",
              requestId: "22222222-2222-4222-8222-222222222222",
            },
          },
          502,
        );
      }
      return jsonResponse({ results: [candidate] });
    });
    const client = createRemoteCatalogClient({
      baseUrl: BASE_URL,
      sharedSecret: SECRET,
      fetch: request as typeof fetch,
    });

    const results = await client.searchReleases({
      artist: "a",
      title: "b",
      userId,
    });

    expect(results).toEqual([candidate]);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("gives up after the retry bound on a persistent retryable failure", async () => {
    const request = vi.fn(async () => new Response(null, { status: 500 }));
    const client = createRemoteCatalogClient({
      baseUrl: BASE_URL,
      sharedSecret: SECRET,
      fetch: request as typeof fetch,
    });

    await expect(
      client.searchReleases({ artist: "a", title: "b", userId }),
    ).rejects.toMatchObject({ category: "provider_unavailable" });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("never retries a non-retryable failure", async () => {
    const request = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: "catalog_not_found",
            message: "No such release.",
            requestId: "33333333-3333-4333-8333-333333333333",
          },
        },
        404,
      ),
    );
    const client = createRemoteCatalogClient({
      baseUrl: BASE_URL,
      sharedSecret: SECRET,
      fetch: request as typeof fetch,
    });

    await expect(
      client.getReleaseDetails({ releaseId, userId }),
    ).rejects.toMatchObject({ category: "not_found" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects a response that does not match the expected schema", async () => {
    const request = vi.fn(async () => jsonResponse({ not: "expected" }));
    const client = createRemoteCatalogClient({
      baseUrl: BASE_URL,
      sharedSecret: SECRET,
      fetch: request as typeof fetch,
    });

    await expect(
      client.searchReleases({ artist: "a", title: "b", userId }),
    ).rejects.toMatchObject({ category: "invalid_response", retryable: false });
  });
});
