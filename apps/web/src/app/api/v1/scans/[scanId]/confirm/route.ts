import {
  ConfirmScanRequestSchema,
  ConfirmScanResponseSchema,
} from "@vinylhound/contracts";
import { confirmScan } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import {
  createRequestId,
  errorResponse,
  jsonResponse,
  parseJson,
  parseUuid,
  requireIdempotencyKey,
} from "@/server/http";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  route: { params: Promise<{ scanId: string }> },
) {
  const requestId = createRequestId();
  try {
    const { scanId: rawScanId } = await route.params;
    const scanId = parseUuid(rawScanId, "scanId");
    const idempotencyKey = requireIdempotencyKey(request);
    const confirmation = await parseJson(request, ConfirmScanRequestSchema);
    const context = getServerContext();
    const userId = await requireUserId(context);
    const result = await confirmScan(context.database.db, {
      userId,
      scanId,
      idempotencyKey,
      confirmation,
    });

    return jsonResponse(
      ConfirmScanResponseSchema.parse(result.record),
      result.created ? 201 : 200,
      requestId,
    );
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
