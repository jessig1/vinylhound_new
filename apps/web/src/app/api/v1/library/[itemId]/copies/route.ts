import {
  CreateLibraryCopySchema,
  LibraryCopySchema,
} from "@vinylhound/contracts";
import { createLibraryCopy } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import {
  jsonResponse,
  parseJson,
  parseUuid,
  requireIdempotencyKey,
  withRoute,
} from "@/server/http";

export const runtime = "nodejs";

/**
 * Records another copy of an owned record (ADR-0024): a second pressing, or
 * a copy again after the last one was removed. Requires `Idempotency-Key` —
 * a copy has no natural identity, so a replay is recognized by its key and
 * returns the copy it created with `200` instead of recording another.
 */
export const POST = withRoute(
  "library.copy.create",
  async (
    request,
    { requestId },
    route: { params: Promise<{ itemId: string }> },
  ) => {
    const idempotencyKey = requireIdempotencyKey(request);
    const params = await route.params;
    const context = getServerContext();
    const result = await createLibraryCopy(context.database.db, {
      userId: await requireUserId(context),
      itemId: parseUuid(params.itemId, "itemId"),
      idempotencyKey,
      copy: await parseJson(request, CreateLibraryCopySchema),
    });
    const response = jsonResponse(
      LibraryCopySchema.parse(result.copy),
      result.created ? 201 : 200,
      requestId,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  },
);
