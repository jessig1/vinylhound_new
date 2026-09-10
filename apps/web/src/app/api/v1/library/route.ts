import {
  GetLibraryResponseSchema,
  LibraryQuerySchema,
} from "@vinylhound/contracts";
import { listLibraryItemsForUser } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { HttpError, jsonResponse, withRoute } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRoute("library.list", async (request, { requestId }) => {
  const searchParams = new URL(request.url).searchParams;
  const parsedQuery = LibraryQuerySchema.safeParse({
    list: searchParams.get("list"),
    q: searchParams.get("q") ?? undefined,
    sort: searchParams.get("sort") ?? undefined,
  });
  if (!parsedQuery.success) {
    throw new HttpError(
      400,
      "invalid_query",
      "The list query parameter must be collection or wishlist, and sort (if provided) must be recent, artist, or title.",
    );
  }
  const context = getServerContext();
  const userId = await requireUserId(context);
  const result = await listLibraryItemsForUser(context.database.db, {
    userId,
    list: parsedQuery.data.list,
    query: parsedQuery.data.q,
    sort: parsedQuery.data.sort,
  });
  const response = jsonResponse(
    GetLibraryResponseSchema.parse(result),
    200,
    requestId,
  );
  response.headers.set("cache-control", "no-store");
  return response;
});
