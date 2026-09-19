import { describe, expect, it } from "vitest";

import { signServiceRequest } from "@vinylhound/service-auth";
import type { CatalogProvider, DiscoveryProvider } from "@vinylhound/catalog";
import type { DiscoveryServiceConfig } from "@vinylhound/config";

import type { DiscoveryServiceContext } from "./context.ts";
import { createRoutes, dispatch } from "./routes.ts";

const SECRET = "correct-horse-battery-staple-correct-horse";
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

function stubCatalog(): CatalogProvider {
  return {
    async searchReleases() {
      return [candidate];
    },
    async getReleaseDetails() {
      return { ...candidate, releaseGroupTitle: "Kind of Blue", tracks: [] };
    },
  };
}

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

function stubDiscovery(): DiscoveryProvider {
  return {
    async search() {
      return { artists: [artist], albums: [album], tracks: [] };
    },
    async getArtist() {
      return { artist, albums: [album] };
    },
    async getAlbum() {
      return { ...album, label: null, barcode: null, genres: [], tracks: [] };
    },
  };
}

function createContext(
  discovery: DiscoveryProvider | null = stubDiscovery(),
): DiscoveryServiceContext {
  return {
    config: {
      DISCOVERY_SERVICE_SHARED_SECRET: SECRET,
    } as DiscoveryServiceConfig,
    catalog: stubCatalog(),
    discovery,
  };
}

function authedRequest(path: string) {
  const token = signServiceRequest(SECRET, { userId });
  return new Request(`http://discovery.internal${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("dispatch", () => {
  it("answers /healthz with no auth required", async () => {
    const routes = createRoutes(createContext());
    const response = await dispatch(
      new Request("http://discovery.internal/healthz"),
      routes,
    );
    expect(response.status).toBe(200);
  });

  it("rejects a catalog search with no auth token", async () => {
    const routes = createRoutes(createContext());
    const response = await dispatch(
      new Request(
        "http://discovery.internal/internal/v1/catalog/releases?artist=a&title=b",
      ),
      routes,
    );
    expect(response.status).toBe(401);
  });

  it("searches the catalog for an authenticated caller", async () => {
    const routes = createRoutes(createContext());
    const response = await dispatch(
      authedRequest("/internal/v1/catalog/releases?artist=Miles&title=Kind"),
      routes,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: unknown[] };
    expect(body.results).toHaveLength(1);
  });

  it("rejects a catalog search missing required query parameters", async () => {
    const routes = createRoutes(createContext());
    const response = await dispatch(
      authedRequest("/internal/v1/catalog/releases?artist=Miles"),
      routes,
    );
    expect(response.status).toBe(400);
  });

  it("fetches catalog release details by id", async () => {
    const routes = createRoutes(createContext());
    const response = await dispatch(
      authedRequest(`/internal/v1/catalog/releases/${releaseId}`),
      routes,
    );
    expect(response.status).toBe(200);
  });

  it("rejects a non-UUID release id", async () => {
    const routes = createRoutes(createContext());
    const response = await dispatch(
      authedRequest("/internal/v1/catalog/releases/not-a-uuid"),
      routes,
    );
    expect(response.status).toBe(400);
  });

  it("searches discovery, and fetches artist and album detail", async () => {
    const routes = createRoutes(createContext());

    const search = await dispatch(
      authedRequest("/internal/v1/discovery/search?q=miles"),
      routes,
    );
    expect(search.status).toBe(200);

    const artistDetail = await dispatch(
      authedRequest(`/internal/v1/discovery/artists/${artist.id}`),
      routes,
    );
    expect(artistDetail.status).toBe(200);

    const albumDetail = await dispatch(
      authedRequest(`/internal/v1/discovery/albums/${album.id}`),
      routes,
    );
    expect(albumDetail.status).toBe(200);
  });

  it("answers 503 discovery_not_configured when no Spotify adapter is wired up", async () => {
    const routes = createRoutes(createContext(null));
    const response = await dispatch(
      authedRequest("/internal/v1/discovery/search?q=miles"),
      routes,
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("discovery_not_configured");
  });

  it("answers 404 for an unknown route", async () => {
    const routes = createRoutes(createContext());
    const response = await dispatch(authedRequest("/internal/v1/nope"), routes);
    expect(response.status).toBe(404);
  });

  it("answers 404 for a non-GET method", async () => {
    const routes = createRoutes(createContext());
    const token = signServiceRequest(SECRET, { userId });
    const response = await dispatch(
      new Request(
        "http://discovery.internal/internal/v1/catalog/releases?artist=a&title=b",
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
      ),
      routes,
    );
    expect(response.status).toBe(404);
  });
});
