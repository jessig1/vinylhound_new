import {
  DeleteLibraryItemResponseSchema,
  UpdateLibraryItemResponseSchema,
  UpdateLibraryItemSchema,
} from "@vinylhound/contracts";
import { deleteLibraryItem, updateLibraryItem } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { jsonResponse, parseJson, parseUuid, withRoute } from "@/server/http";

export const runtime = "nodejs";

export const PATCH = withRoute(
  "library.item.update",
  async (
    request,
    { requestId },
    route: { params: Promise<{ itemId: string }> },
  ) => {
    const { itemId: rawItemId } = await route.params;
    const itemId = parseUuid(rawItemId, "itemId");
    const update = await parseJson(request, UpdateLibraryItemSchema);
    const context = getServerContext();
    const userId = await requireUserId(context);
    const result = await updateLibraryItem(context.database.db, {
      userId,
      itemId,
      update,
    });

    const response = jsonResponse(
      UpdateLibraryItemResponseSchema.parse(result),
      200,
      requestId,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  },
);

export const DELETE = withRoute(
  "library.item.delete",
  async (
    _request,
    { requestId },
    route: { params: Promise<{ itemId: string }> },
  ) => {
    const { itemId: rawItemId } = await route.params;
    const itemId = parseUuid(rawItemId, "itemId");
    const context = getServerContext();
    const userId = await requireUserId(context);
    const result = await deleteLibraryItem(context.database.db, {
      userId,
      itemId,
    });

    const response = jsonResponse(
      DeleteLibraryItemResponseSchema.parse(result),
      200,
      requestId,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  },
);
