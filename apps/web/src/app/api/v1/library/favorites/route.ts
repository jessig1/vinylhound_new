import {
  FavoritesQuerySchema,
  GetFavoritesResponseSchema,
} from "@vinylhound/contracts";
import { listFavoriteLibraryItemsForUser } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { HttpError, jsonResponse, withRoute } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Favorites across both lists. A favorite is an attribute of a saved record,
 * not a third list (ADR-0021), so there is no `list` parameter; toggling is
 * `PATCH /library/{itemId}` with `{ favorite }`. Paged like `GET /library`
 * (ADR-0023).
 */
export const GET = withRoute(
  "library.favorites",
  async (request, { requestId }) => {
    const searchParams = new URL(request.url).searchParams;
    const parsedQuery = FavoritesQuerySchema.safeParse({
      q: searchParams.get("q") ?? undefined,
      sort: searchParams.get("sort") ?? undefined,
      cursor: searchParams.get("cursor") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    });
    if (!parsedQuery.success) {
      throw new HttpError(
        400,
        "invalid_query",
        "sort (if provided) must be recent, artist, or title; limit (if provided) must be an integer from 1 to 100.",
      );
    }
    const context = getServerContext();
    const userId = await requireUserId(context);
    const result = await listFavoriteLibraryItemsForUser(context.database.db, {
      userId,
      query: parsedQuery.data.q,
      sort: parsedQuery.data.sort,
      cursor: parsedQuery.data.cursor,
      limit: parsedQuery.data.limit,
    });
    const response = jsonResponse(
      GetFavoritesResponseSchema.parse(result),
      200,
      requestId,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  },
);
