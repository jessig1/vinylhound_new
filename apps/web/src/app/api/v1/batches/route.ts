import { CreateBatchResponseSchema } from "@vinylhound/contracts";
import { createOrGetBatch } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import {
  createRequestId,
  errorResponse,
  jsonResponse,
  requireIdempotencyKey,
} from "@/server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
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
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
