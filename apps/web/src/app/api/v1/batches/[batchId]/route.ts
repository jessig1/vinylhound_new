import { GetBatchResponseSchema } from "@vinylhound/contracts";
import {
  getBatchCostSummary,
  getBatchForUser,
  listScanSummariesForUser,
} from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { jsonResponse, parseUuid, withRoute } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRoute(
  "batches.get",
  async (
    _request,
    { requestId },
    route: { params: Promise<{ batchId: string }> },
  ) => {
    const { batchId: rawBatchId } = await route.params;
    const batchId = parseUuid(rawBatchId, "batchId");
    const context = getServerContext();
    const userId = await requireUserId(context);

    const { batch, scanIds } = await getBatchForUser(context.database.db, {
      userId,
      batchId,
    });
    const [scanSummaries, cost] = await Promise.all([
      listScanSummariesForUser(context.database.db, { userId, scanIds }),
      getBatchCostSummary(context.database.db, { batchId, scanIds }),
    ]);

    const response = jsonResponse(
      GetBatchResponseSchema.parse({
        batchId: batch.id,
        createdAt: batch.createdAt.toISOString(),
        scans: scanSummaries.map(
          ({
            scanId,
            status,
            createdAt,
            completedAt,
            thumbnailImageId,
            topCandidate,
          }) => ({
            scanId,
            status,
            createdAt,
            completedAt,
            thumbnailImageId,
            topCandidate,
          }),
        ),
        cost,
      }),
      200,
      requestId,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  },
);
