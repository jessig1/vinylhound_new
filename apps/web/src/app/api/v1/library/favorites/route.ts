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
 * `PATCH /library/{itemId}` with `{ favorite }`.
 */
export const GET = withRoute(
  "library.favorites",
  async (request, { requestId }) => {
    const searchParams = new URL(request.url).searchParams;
    const parsedQuery = FavoritesQuerySchema.safeParse({
      q: searchParams.get("q") ?? undefined,
      sort: searchParams.get("sort") ?? undefined,
    });
    if (!parsedQuery.success) {
      throw new HttpError(
        400,
        "invalid_query",
        "sort (if provided) must be recent, artist, or title.",
      );
    }
    const context = getServerContext();
    const userId = await requireUserId(context);
    const result = await listFavoriteLibraryItemsForUser(
      context.database.db,
      {
        userId,
        query: parsedQuery.data.q,
        sort: parsedQuery.data.sort,
      },
    );
    const response = jsonResponse(
      GetFavoritesResponseSchema.parse(result),
      200,
      requestId,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  },
);
