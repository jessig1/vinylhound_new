import { describe, expect, it } from "vitest";

import { DiscoveryProviderError } from "./discovery-provider.ts";
import { createSpotifyDiscovery } from "./spotify-discovery.ts";

const TOKEN_URL = "https://accounts.test/token";
const BASE_URL = "https://api.test/v1";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const tokenBody = { access_token: "token-1", expires_in: 3600 };

const milesArtist = {
  id: "0kbYTNQb4Pb1rPbbaF0pT4",
  name: "Miles Davis",
  images: [{ url: "https://i.test/miles-640.jpg", width: 640, height: 640 }],
  genres: ["jazz", "bebop"],
  popularity: 74,
  external_urls: {
    spotify: "https://open.spotify.com/artist/0kbYTNQb4Pb1rPbbaF0pT4",
  },
};

const kindOfBlueAlbum = {
  id: "1weenld61qoidwYuZ1GESA",
  name: "Kind of Blue",
  album_type: "album",
  artists: [{ id: "0kbYTNQb4Pb1rPbbaF0pT4", name: "Miles Davis" }],
  images: [{ url: "https://i.test/kob-640.jpg", width: 640, height: 640 }],
  release_date: "1959-08-17",
  total_tracks: 5,
  external_urls: {
    spotify: "https://open.spotify.com/album/1weenld61qoidwYuZ1GESA",
  },
};

function createProvider(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const calls: string[] = [];
  const provider = createSpotifyDiscovery({
    clientId: "id",
    clientSecret: "secret",
    accountsUrl: TOKEN_URL,
    baseUrl: BASE_URL,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      return handler(url, init);
    }) as typeof fetch,
  });
  return { provider, calls };
}

describe("createSpotifyDiscovery", () => {
  it("requests a client-credentials token once and reuses it across calls", async () => {
    const { provider, calls } = createProvider((url) => {
      if (url === TOKEN_URL) return jsonResponse(tokenBody);
      return jsonResponse({ artists: { items: [milesArtist] } });
    });

    await provider.search({ query: "miles davis", type: "artist" });
    await provider.search({ query: "coltrane", type: "artist" });

    expect(calls.filter((url) => url === TOKEN_URL)).toHaveLength(1);
  });

  it("maps artists, albums and tracks out of one unified search", async () => {
    const { provider } = createProvider((url) => {
      if (url === TOKEN_URL) return jsonResponse(tokenBody);
      return jsonResponse({
        artists: { items: [milesArtist] },
        albums: { items: [kindOfBlueAlbum] },
        tracks: {
          items: [
            {
              id: "7q3kkfAVpmcZ8g6JUThi3o",
              name: "So What",
              artists: [{ id: "0kbYTNQb4Pb1rPbbaF0pT4", name: "Miles Davis" }],
              album: kindOfBlueAlbum,
              duration_ms: 562_000,
              track_number: 1,
              disc_number: 1,
              external_urls: {
                spotify:
                  "https://open.spotify.com/track/7q3kkfAVpmcZ8g6JUThi3o",
              },
            },
          ],
        },
      });
    });

    const results = await provider.search({ query: "kind of blue" });

    expect(results.artists[0]).toMatchObject({
      id: "0kbYTNQb4Pb1rPbbaF0pT4",
      name: "Miles Davis",
      imageUrl: "https://i.test/miles-640.jpg",
      genres: ["jazz", "bebop"],
    });
    expect(results.albums[0]).toMatchObject({
      title: "Kind of Blue",
      artist: "Miles Davis",
      releaseDate: "1959-08-17",
      releaseYear: 1959,
      coverUrl: "https://i.test/kob-640.jpg",
    });
    expect(results.tracks[0]).toMatchObject({
      title: "So What",
      albumId: "1weenld61qoidwYuZ1GESA",
      albumTitle: "Kind of Blue",
      durationMs: 562_000,
    });
  });

  it("drops null entries and unusable placeholder release dates", async () => {
    const { provider } = createProvider((url) => {
      if (url === TOKEN_URL) return jsonResponse(tokenBody);
      return jsonResponse({
        albums: {
          items: [
            null,
            { ...kindOfBlueAlbum, release_date: "0000" },
            // No artist credit at all: unusable as a result row.
            { ...kindOfBlueAlbum, id: "2weenld61qoidwYuZ1GESA", artists: [] },
          ],
        },
      });
    });

    const results = await provider.search({
      query: "kind of blue",
      type: "album",
    });

    expect(results.albums).toHaveLength(1);
    expect(results.albums[0]).toMatchObject({
      releaseDate: null,
      releaseYear: null,
    });
  });

  it("collapses an artist's repeated per-market albums into one discography entry", async () => {
    const { provider } = createProvider((url) => {
      if (url === TOKEN_URL) return jsonResponse(tokenBody);
      if (url.includes("/albums")) {
        return jsonResponse({
          items: [
            { ...kindOfBlueAlbum, images: [] },
            { ...kindOfBlueAlbum, id: "3weenld61qoidwYuZ1GESA" },
            {
              ...kindOfBlueAlbum,
              id: "4weenld61qoidwYuZ1GESA",
              name: "Sketches of Spain",
              release_date: "1960-07-18",
            },
          ],
        });
      }
      return jsonResponse(milesArtist);
    });

    const { artist, albums } = await provider.getArtist(
      "0kbYTNQb4Pb1rPbbaF0pT4",
    );

    expect(artist.name).toBe("Miles Davis");
    expect(albums).toHaveLength(2);
    // Newest first, and the duplicate that carried artwork wins.
    expect(albums[0]?.title).toBe("Sketches of Spain");
    expect(albums[1]).toMatchObject({
      title: "Kind of Blue",
      coverUrl: "https://i.test/kob-640.jpg",
    });
  });

  it("reads label, barcode and tracks from an album lookup", async () => {
    const { provider } = createProvider((url) => {
      if (url === TOKEN_URL) return jsonResponse(tokenBody);
      return jsonResponse({
        ...kindOfBlueAlbum,
        label: "Columbia",
        genres: ["jazz"],
        external_ids: { upc: "888880668875" },
        tracks: {
          items: [
            {
              id: "7q3kkfAVpmcZ8g6JUThi3o",
              name: "So What",
              duration_ms: 562_000,
              track_number: 1,
              disc_number: 1,
              external_urls: {
                spotify:
                  "https://open.spotify.com/track/7q3kkfAVpmcZ8g6JUThi3o",
              },
            },
          ],
        },
      });
    });

    const album = await provider.getAlbum("1weenld61qoidwYuZ1GESA");

    expect(album).toMatchObject({
      title: "Kind of Blue",
      label: "Columbia",
      barcode: "888880668875",
      genres: ["jazz"],
    });
    // Simplified album tracks carry no artist of their own; the album's is used.
    expect(album.tracks[0]).toMatchObject({
      title: "So What",
      artist: "Miles Davis",
      albumId: "1weenld61qoidwYuZ1GESA",
      albumTitle: "Kind of Blue",
    });
  });

  it("rejects a malformed Spotify ID without spending a request", async () => {
    const { provider, calls } = createProvider((url) => {
      if (url === TOKEN_URL) return jsonResponse(tokenBody);
      throw new Error("should not reach the API");
    });

    await expect(provider.getAlbum("not-a-spotify-id")).rejects.toMatchObject({
      category: "not_found",
    });
    expect(calls).toHaveLength(0);
  });

  it("refreshes the token once when a cached one is rejected", async () => {
    let tokenRequests = 0;
    let apiRequests = 0;
    const { provider } = createProvider((url) => {
      if (url === TOKEN_URL) {
        tokenRequests += 1;
        return jsonResponse({
          ...tokenBody,
          access_token: `token-${tokenRequests}`,
        });
      }
      apiRequests += 1;
      return apiRequests === 1
        ? jsonResponse({ error: { status: 401 } }, 401)
        : jsonResponse({ artists: { items: [milesArtist] } });
    });

    const results = await provider.search({ query: "miles", type: "artist" });

    expect(tokenRequests).toBe(2);
    expect(results.artists).toHaveLength(1);
  });

  it("maps a rate-limited response to a retryable rate_limit error", async () => {
    const { provider } = createProvider((url) => {
      if (url === TOKEN_URL) return jsonResponse(tokenBody);
      return jsonResponse({}, 429);
    });

    await expect(
      provider.search({ query: "miles", type: "artist" }),
    ).rejects.toMatchObject({ category: "rate_limit", retryable: true });
  });

  it("maps rejected credentials to not_configured rather than a retry", async () => {
    const { provider } = createProvider((url) => {
      if (url === TOKEN_URL)
        return jsonResponse({ error: "invalid_client" }, 400);
      return jsonResponse({});
    });

    const failure = await provider
      .search({ query: "miles", type: "artist" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DiscoveryProviderError);
    expect(failure).toMatchObject({
      category: "not_configured",
      retryable: false,
    });
  });

  it("maps an unknown album to not_found", async () => {
    const { provider } = createProvider((url) => {
      if (url === TOKEN_URL) return jsonResponse(tokenBody);
      return jsonResponse({ error: { status: 404 } }, 404);
    });

    await expect(
      provider.getAlbum("1weenld61qoidwYuZ1GESA"),
    ).rejects.toMatchObject({ category: "not_found" });
  });

  it("surfaces Spotify's own refusal text on a 403 instead of a generic failure", async () => {
    // Spotify answers 403 with a plain-text explanation when the account that
    // owns the app has no active Premium subscription. That sentence is the
    // entire diagnosis, so it has to reach the operator.
    const { provider } = createProvider((url) => {
      if (url === TOKEN_URL) return jsonResponse(tokenBody);
      return new Response(
        "Active premium subscription required for the owner of the app.",
        { status: 403 },
      );
    });

    const failure = await provider
      .search({ query: "miles", type: "artist" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DiscoveryProviderError);
    expect(failure).toMatchObject({
      category: "not_configured",
      retryable: false,
    });
    expect((failure as Error).message).toContain(
      "Active premium subscription required",
    );
  });

  it("includes the upstream status and reason on an unexpected failure", async () => {
    const { provider } = createProvider((url) => {
      if (url === TOKEN_URL) return jsonResponse(tokenBody);
      return jsonResponse(
        { error: { message: "Service temporarily down" } },
        503,
      );
    });

    const failure = await provider
      .search({ query: "miles", type: "artist" })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      category: "provider_unavailable",
      retryable: true,
    });
    expect((failure as Error).message).toContain("503");
    expect((failure as Error).message).toContain("Service temporarily down");
  });
});
