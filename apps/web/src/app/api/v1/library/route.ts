import {
  GetLibraryResponseSchema,
  LibraryQuerySchema,
  PlaceLibraryReleaseResponseSchema,
  PlaceLibraryReleaseSchema,
} from "@vinylhound/contracts";
import {
  listLibraryItemsForUser,
  placeLibraryRelease,
} from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { HttpError, jsonResponse, parseJson, withRoute } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One page of the selected list. `cursor` continues from a previous page's
 * `nextCursor` under the same `sort` (ADR-0023); a cursor the server cannot
 * read is `400 invalid_cursor`.
 */
export const GET = withRoute("library.list", async (request, { requestId }) => {
  const searchParams = new URL(request.url).searchParams;
  const parsedQuery = LibraryQuerySchema.safeParse({
    list: searchParams.get("list"),
    q: searchParams.get("q") ?? undefined,
    sort: searchParams.get("sort") ?? undefined,
    cursor: searchParams.get("cursor") ?? undefined,
    limit: searchParams.get("limit") ?? undefined,
  });
  if (!parsedQuery.success) {
    throw new HttpError(
      400,
      "invalid_query",
      "The list query parameter must be collection or wishlist; sort (if provided) must be recent, artist, or title; limit (if provided) must be an integer from 1 to 100.",
    );
  }
  const context = getServerContext();
  const userId = await requireUserId(context);
  const result = await listLibraryItemsForUser(context.database.db, {
    userId,
    list: parsedQuery.data.list,
    query: parsedQuery.data.q,
    sort: parsedQuery.data.sort,
    cursor: parsedQuery.data.cursor,
    limit: parsedQuery.data.limit,
  });
  const response = jsonResponse(
    GetLibraryResponseSchema.parse(result),
    200,
    requestId,
  );
  response.headers.set("cache-control", "no-store");
  return response;
});

/**
 * Saves a release into the library with no scan involved — the `/discover`
 * path (ADR-0019). No `Idempotency-Key` is required: the write is idempotent
 * by identity, upserting on `(user_id, release_id)` and adding an owned copy
 * only when the item has none yet, so a double-tap converges instead of
 * stacking duplicates.
 */
export const POST = withRoute(
  "library.place",
  async (request, { requestId }) => {
    const parsed = await parseJson(request, PlaceLibraryReleaseSchema);
    const context = getServerContext();
    const userId = await requireUserId(context);
    // Provenance is stamped here rather than trusted from the body: the caller
    // decides which release to save, never when the record claims to have been
    // looked up.
    const placement = parsed.catalogReference
      ? {
          ...parsed,
          catalogReference: {
            ...parsed.catalogReference,
            fetchedAt: new Date().toISOString(),
          },
        }
      : parsed;
    const { record, created } = await placeLibraryRelease(context.database.db, {
      userId,
      placement,
    });
    return jsonResponse(
      PlaceLibraryReleaseResponseSchema.parse(record),
      created ? 201 : 200,
      requestId,
    );
  },
);
