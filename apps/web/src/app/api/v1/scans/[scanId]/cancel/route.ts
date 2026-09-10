import { CancelScanResponseSchema } from "@vinylhound/contracts";
import { cancelScan } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import {
  jsonResponse,
  parseUuid,
  requireIdempotencyKey,
  withRoute,
} from "@/server/http";

export const runtime = "nodejs";

export const POST = withRoute(
  "scans.cancel",
  async (
    request,
    { requestId },
    route: { params: Promise<{ scanId: string }> },
  ) => {
    const { scanId: rawScanId } = await route.params;
    const scanId = parseUuid(rawScanId, "scanId");
    requireIdempotencyKey(request);
    const context = getServerContext();
    const userId = await requireUserId(context);

    const result = await cancelScan(context.database.db, {
      userId,
      scanId,
    });
    const response = CancelScanResponseSchema.parse({
      scanId: result.record.id,
      status: result.record.status,
    });

    return jsonResponse(response, 200, requestId);
  },
);
