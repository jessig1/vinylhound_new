import { GetBatchResponseSchema } from "@vinylhound/contracts";
import {
  getBatchForUser,
  listScanSummariesForUser,
} from "@vinylhound/database";

import { getServerContext } from "@/server/context";
import {
  createRequestId,
  errorResponse,
  jsonResponse,
  parseUuid,
} from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  route: { params: Promise<{ batchId: string }> },
) {
  const requestId = createRequestId();
  try {
    const { batchId: rawBatchId } = await route.params;
    const batchId = parseUuid(rawBatchId, "batchId");
    const context = getServerContext();
    const userId = context.config.DEVELOPMENT_USER_ID;

    const { batch, scanIds } = await getBatchForUser(context.database.db, {
      userId,
      batchId,
    });
    const scanSummaries = await listScanSummariesForUser(context.database.db, {
      userId,
      scanIds,
    });

    const response = jsonResponse(
      GetBatchResponseSchema.parse({
        batchId: batch.id,
        createdAt: batch.createdAt.toISOString(),
        scans: scanSummaries.map(
          ({ scanId, status, createdAt, completedAt, topCandidate }) => ({
            scanId,
            status,
            createdAt,
            completedAt,
            topCandidate,
          }),
        ),
      }),
      200,
      requestId,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
