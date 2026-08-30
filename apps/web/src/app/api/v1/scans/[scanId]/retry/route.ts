import { RetryScanResponseSchema } from "@vinylhound/contracts";
import { retryScan } from "@vinylhound/database";

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
    requireIdempotencyKey(request);
    const context = getServerContext();

    const result = await retryScan(context.database.db, {
      userId: context.config.DEVELOPMENT_USER_ID,
      scanId,
    });
    const response = RetryScanResponseSchema.parse({
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
