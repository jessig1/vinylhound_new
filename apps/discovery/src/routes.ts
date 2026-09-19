import { z } from "zod";

import {
  DiscoverySearchQuerySchema,
  DiscoveryAlbumDetailResponseSchema,
  DiscoveryArtistDetailResponseSchema,
  DiscoverySearchResponseSchema,
  GetCatalogReleaseResponseSchema,
  SearchCatalogReleasesResponseSchema,
} from "@vinylhound/contracts";
import { DiscoveryProviderError } from "@vinylhound/catalog";

import type { DiscoveryServiceContext } from "./context.ts";
import {
  HttpError,
  jsonResponse,
  requireServiceUserId,
  withRoute,
  type RequestContext,
} from "./http.ts";

const SearchCatalogReleasesQuerySchema = z.object({
  artist: z.string().trim().min(1).max(255),
  title: z.string().trim().min(1).max(255),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

function requireDiscovery(context: DiscoveryServiceContext) {
  if (!context.discovery) {
    throw new DiscoveryProviderError(
      "not_configured",
      false,
      "Discovery is not configured for this deployment.",
    );
  }
  return context.discovery;
}

export function healthzRoute() {
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export function createRoutes(context: DiscoveryServiceContext) {
  const catalogSearch = withRoute(
    "catalog.releases.search",
    async (request: Request, { requestId }: RequestContext) => {
      const userId = requireServiceUserId(
        request,
        context.config.DISCOVERY_SERVICE_SHARED_SECRET,
      );
      const url = new URL(request.url);
      const parsed = SearchCatalogReleasesQuerySchema.safeParse({
        artist: url.searchParams.get("artist"),
        title: url.searchParams.get("title"),
        limit: url.searchParams.get("limit") ?? undefined,
      });
      if (!parsed.success) {
        throw new HttpError(
          400,
          "invalid_catalog_query",
          "Artist and title are required catalog search parameters.",
        );
      }
      const results = await context.catalog.searchReleases({
        ...parsed.data,
        userId,
      });
      return jsonResponse(
        SearchCatalogReleasesResponseSchema.parse({ results }),
        200,
        requestId,
      );
    },
  );

  const catalogReleaseDetails = withRoute(
    "catalog.releases.details",
    async (
      request: Request,
      { requestId }: RequestContext,
      releaseId: string,
    ) => {
      const userId = requireServiceUserId(
        request,
        context.config.DISCOVERY_SERVICE_SHARED_SECRET,
      );
      const parsedId = z.string().uuid().safeParse(releaseId);
      if (!parsedId.success) {
        throw new HttpError(
          400,
          "invalid_identifier",
          "releaseId must be a UUID.",
        );
      }
      const release = await context.catalog.getReleaseDetails({
        releaseId: parsedId.data,
        userId,
      });
      return jsonResponse(
        GetCatalogReleaseResponseSchema.parse({ release }),
        200,
        requestId,
      );
    },
  );

  const discoverySearch = withRoute(
    "discovery.search",
    async (request: Request, { requestId }: RequestContext) => {
      const userId = requireServiceUserId(
        request,
        context.config.DISCOVERY_SERVICE_SHARED_SECRET,
      );
      const url = new URL(request.url);
      const parsed = DiscoverySearchQuerySchema.safeParse({
        q: url.searchParams.get("q"),
        type: url.searchParams.get("type") ?? undefined,
        limit: url.searchParams.get("limit") ?? undefined,
      });
      if (!parsed.success) {
        throw new HttpError(
          400,
          "invalid_discovery_query",
          "A search needs a q of 1-200 characters; type must be all, artist, album, or track.",
        );
      }
      const results = await requireDiscovery(context).search({
        query: parsed.data.q,
        type: parsed.data.type,
        limit: parsed.data.limit,
        userId,
      });
      return jsonResponse(
        DiscoverySearchResponseSchema.parse({
          ...results,
          query: parsed.data.q,
          type: parsed.data.type,
        }),
        200,
        requestId,
      );
    },
  );

  const discoveryArtist = withRoute(
    "discovery.artists.details",
    async (
      request: Request,
      { requestId }: RequestContext,
      artistId: string,
    ) => {
      const userId = requireServiceUserId(
        request,
        context.config.DISCOVERY_SERVICE_SHARED_SECRET,
      );
      const { artist, albums } = await requireDiscovery(context).getArtist({
        artistId,
        userId,
      });
      return jsonResponse(
        DiscoveryArtistDetailResponseSchema.parse({ artist, albums }),
        200,
        requestId,
      );
    },
  );

  const discoveryAlbum = withRoute(
    "discovery.albums.details",
    async (
      request: Request,
      { requestId }: RequestContext,
      albumId: string,
    ) => {
      const userId = requireServiceUserId(
        request,
        context.config.DISCOVERY_SERVICE_SHARED_SECRET,
      );
      const album = await requireDiscovery(context).getAlbum({
        albumId,
        userId,
      });
      return jsonResponse(
        DiscoveryAlbumDetailResponseSchema.parse({ album }),
        200,
        requestId,
      );
    },
  );

  return {
    catalogSearch,
    catalogReleaseDetails,
    discoverySearch,
    discoveryArtist,
    discoveryAlbum,
  };
}

export type DiscoveryServiceRoutes = ReturnType<typeof createRoutes>;

/**
 * Matches `GET /healthz` and `GET /internal/v1/<catalog|discovery>/...`
 * against the handlers above. A small hand-rolled table rather than a
 * routing library: five fixed routes plus health do not need one, matching
 * this repository's preference (see ADR on `scripts/affected/`) for a small
 * custom mechanism over a new dependency.
 */
export async function dispatch(
  request: Request,
  routes: DiscoveryServiceRoutes,
): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/healthz") {
    return healthzRoute();
  }
  if (request.method !== "GET") {
    return notFound();
  }
  // ["internal", "v1", "catalog"|"discovery", resource, id?]
  if (segments[0] !== "internal" || segments[1] !== "v1") {
    return notFound();
  }
  if (segments[2] === "catalog" && segments[3] === "releases") {
    if (segments.length === 4) return routes.catalogSearch(request);
    if (segments.length === 5)
      return routes.catalogReleaseDetails(request, segments[4]!);
  }
  if (segments[2] === "discovery") {
    if (segments[3] === "search" && segments.length === 4) {
      return routes.discoverySearch(request);
    }
    if (segments[3] === "artists" && segments.length === 5) {
      return routes.discoveryArtist(request, segments[4]!);
    }
    if (segments[3] === "albums" && segments.length === 5) {
      return routes.discoveryAlbum(request, segments[4]!);
    }
  }
  return notFound();
}

function notFound() {
  return new Response(
    JSON.stringify({ error: { code: "not_found", message: "No such route." } }),
    { status: 404, headers: { "content-type": "application/json" } },
  );
}
