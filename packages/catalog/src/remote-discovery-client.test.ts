import { describe, expect, it, vi } from "vitest";

import { verifyServiceRequest } from "@vinylhound/service-auth";

import { createRemoteDiscoveryClient } from "./remote-discovery-client.ts";

const SECRET = "correct-horse-battery-staple-correct-horse";
const BASE_URL = "http://discovery.internal:4001";
const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const artist = {
  id: "0kbYTNQb4Pb1rPbbaF0pT4",
  name: "Miles Davis",
  imageUrl: null,
  genres: [],
  popularity: null,
  externalUrl: "https://open.spotify.com/artist/0kbYTNQb4Pb1rPbbaF0pT4",
};

const album = {
  id: "1weenld61qoidwYuZ1GESA",
  title: "Kind of Blue",
  artist: "Miles Davis",
  artistIds: [artist.id],
  albumType: "album" as const,
  releaseDate: "1959-08-17",
  releaseYear: 1959,
  totalTracks: 5,
  coverUrl: null,
  externalUrl: "https://open.spotify.com/album/1weenld61qoidwYuZ1GESA",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createRemoteDiscoveryClient", () => {
  it("signs the search request with a valid, user-bound token", async () => {
    const request = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const header = (init?.headers as Record<string, string>).authorization;
        const token = header.replace(/^Bearer /, "");
        expect(verifyServiceRequest(SECRET, token)).toEqual({ userId });
        return jsonResponse({
          artists: [artist],
          albums: [],
          tracks: [],
          query: "miles davis",
          type: "artist",
        });
      },
    );
    const client = createRemoteDiscoveryClient({
      baseUrl: BASE_URL,
      sharedSecret: SECRET,
      fetch: request as typeof fetch,
    });

    const results = await client.search({
      query: "miles davis",
      type: "artist",
      userId,
    });

    expect(results.artists).toEqual([artist]);
    const [url] = request.mock.calls[0]!;
    expect(String(url)).toBe(
      `${BASE_URL}/internal/v1/discovery/search?q=miles+davis&type=artist`,
    );
  });

  it("fetches artist detail from the artist-id path", async () => {
    const request = vi.fn(async () =>
      jsonResponse({ artist, albums: [album] }),
    );
    const client = createRemoteDiscoveryClient({
      baseUrl: BASE_URL,
      sharedSecret: SECRET,
      fetch: request as typeof fetch,
    });

    const result = await client.getArtist({ artistId: artist.id, userId });

    expect(result.albums).toEqual([album]);
    const [url] = request.mock.calls[0] as unknown as [RequestInfo | URL];
    expect(String(url)).toBe(
      `${BASE_URL}/internal/v1/discovery/artists/${artist.id}`,
    );
  });

  it("fetches album detail from the album-id path", async () => {
    const request = vi.fn(async () =>
      jsonResponse({
        album: { ...album, label: null, barcode: null, genres: [], tracks: [] },
      }),
    );
    const client = createRemoteDiscoveryClient({
      baseUrl: BASE_URL,
      sharedSecret: SECRET,
      fetch: request as typeof fetch,
    });

    const detail = await client.getAlbum({ albumId: album.id, userId });

    expect(detail.title).toBe("Kind of Blue");
    const [url] = request.mock.calls[0] as unknown as [RequestInfo | URL];
    expect(String(url)).toBe(
      `${BASE_URL}/internal/v1/discovery/albums/${album.id}`,
    );
  });

  it("maps a 503 not_configured response to the matching category", async () => {
    const request = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: "discovery_not_configured",
            message: "Discovery is not configured for this deployment.",
            requestId: "11111111-1111-4111-8111-111111111111",
          },
        },
        503,
      ),
    );
    const client = createRemoteDiscoveryClient({
      baseUrl: BASE_URL,
      sharedSecret: SECRET,
      fetch: request as typeof fetch,
    });

    await expect(
      client.search({ query: "miles", userId }),
    ).rejects.toMatchObject({ category: "not_configured", retryable: false });
  });

  it("falls back to a retryable provider_unavailable for an unrecognized failure", async () => {
    const request = vi.fn(async () => new Response(null, { status: 500 }));
    const client = createRemoteDiscoveryClient({
      baseUrl: BASE_URL,
      sharedSecret: SECRET,
      fetch: request as typeof fetch,
    });

    await expect(
      client.search({ query: "miles", userId }),
    ).rejects.toMatchObject({
      category: "provider_unavailable",
      retryable: true,
    });
  });

  it("retries a retryable failure and succeeds within the bound", async () => {
    let calls = 0;
    const request = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return new Response(null, { status: 500 });
      return jsonResponse({
        artists: [artist],
        albums: [],
        tracks: [],
        query: "miles",
        type: "all",
      });
    });
    const client = createRemoteDiscoveryClient({
      baseUrl: BASE_URL,
      sharedSecret: SECRET,
      fetch: request as typeof fetch,
    });

    const results = await client.search({ query: "miles", userId });

    expect(results.artists).toEqual([artist]);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("gives up after the retry bound on a persistent retryable failure", async () => {
    const request = vi.fn(async () => new Response(null, { status: 500 }));
    const client = createRemoteDiscoveryClient({
      baseUrl: BASE_URL,
      sharedSecret: SECRET,
      fetch: request as typeof fetch,
    });

    await expect(
      client.search({ query: "miles", userId }),
    ).rejects.toMatchObject({ category: "provider_unavailable" });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("never retries a non-retryable failure", async () => {
    const request = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: "discovery_not_configured",
            message: "Discovery is not configured for this deployment.",
            requestId: "11111111-1111-4111-8111-111111111111",
          },
        },
        503,
      ),
    );
    const client = createRemoteDiscoveryClient({
      baseUrl: BASE_URL,
      sharedSecret: SECRET,
      fetch: request as typeof fetch,
    });

    await expect(
      client.search({ query: "miles", userId }),
    ).rejects.toMatchObject({ category: "not_configured" });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
