import {
  DeleteLibraryCopyResponseSchema,
  LibraryCopySchema,
  UpdateLibraryCopySchema,
} from "@vinylhound/contracts";
import { deleteLibraryCopy, updateLibraryCopy } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
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
  route: { params: Promise<{ itemId: string; copyId: string }> },
) {
  const requestId = createRequestId();
  try {
    const params = await route.params;
    const context = getServerContext();
    const result = await updateLibraryCopy(context.database.db, {
      userId: await requireUserId(context),
      itemId: parseUuid(params.itemId, "itemId"),
      copyId: parseUuid(params.copyId, "copyId"),
      update: await parseJson(request, UpdateLibraryCopySchema),
    });
    const response = jsonResponse(
      LibraryCopySchema.parse(result),
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
  route: { params: Promise<{ itemId: string; copyId: string }> },
) {
  const requestId = createRequestId();
  try {
    const params = await route.params;
    const context = getServerContext();
    const result = await deleteLibraryCopy(context.database.db, {
      userId: await requireUserId(context),
      itemId: parseUuid(params.itemId, "itemId"),
      copyId: parseUuid(params.copyId, "copyId"),
    });
    const response = jsonResponse(
      DeleteLibraryCopyResponseSchema.parse(result),
      200,
      requestId,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
