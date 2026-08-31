import {
  DeleteLibraryItemResponseSchema,
  UpdateLibraryItemResponseSchema,
  UpdateLibraryItemSchema,
} from "@vinylhound/contracts";
import { deleteLibraryItem, updateLibraryItem } from "@vinylhound/database";

import { getServerContext } from "@/server/context";
import {
  createRequestId,
  errorResponse,
  jsonResponse,
  parseJson,
  parseUuid,
} from "@/server/http";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  route: { params: Promise<{ itemId: string }> },
) {
  const requestId = createRequestId();
  try {
    const { itemId: rawItemId } = await route.params;
    const itemId = parseUuid(rawItemId, "itemId");
    const update = await parseJson(request, UpdateLibraryItemSchema);
    const context = getServerContext();
    const result = await updateLibraryItem(context.database.db, {
      userId: context.config.DEVELOPMENT_USER_ID,
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
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

export async function DELETE(
  _request: Request,
  route: { params: Promise<{ itemId: string }> },
) {
  const requestId = createRequestId();
  try {
    const { itemId: rawItemId } = await route.params;
    const itemId = parseUuid(rawItemId, "itemId");
    const context = getServerContext();
    const result = await deleteLibraryItem(context.database.db, {
      userId: context.config.DEVELOPMENT_USER_ID,
      itemId,
    });

    const response = jsonResponse(
      DeleteLibraryItemResponseSchema.parse(result),
      200,
      requestId,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
