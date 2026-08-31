import { SubmitScanResponseSchema } from "@vinylhound/contracts";
import { submitScan } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import {
  createRequestId,
  errorResponse,
  jsonResponse,
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
    const context = getServerContext();
    const userId = await requireUserId(context);

    const result = await submitScan(context.database.db, {
      userId,
      scanId,
      idempotencyKey,
    });
    const response = SubmitScanResponseSchema.parse({
      scanId: result.record.id,
      status: result.record.status,
      attemptNumber: result.job.attemptNumber,
      jobId: result.jobId,
    });

    return jsonResponse(response, result.created ? 202 : 200, requestId);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
