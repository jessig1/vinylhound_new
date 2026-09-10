import { CreateBatchResponseSchema } from "@vinylhound/contracts";
import { createOrGetBatch } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { jsonResponse, requireIdempotencyKey, withRoute } from "@/server/http";

export const runtime = "nodejs";

export const POST = withRoute(
  "batches.create",
  async (request, { requestId }) => {
    const idempotencyKey = requireIdempotencyKey(request);
    const context = getServerContext();
    const userId = await requireUserId(context);

    const result = await createOrGetBatch(context.database.db, {
      userId,
      idempotencyKey,
    });
    const response = CreateBatchResponseSchema.parse({
      batchId: result.record.id,
      createdAt: result.record.createdAt.toISOString(),
    });

    return jsonResponse(response, result.created ? 201 : 200, requestId);
  },
);
