import { ConfirmScanResponseSchema } from "@vinylhound/contracts";
import { reconcileScanConfirmation } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import {
  jsonResponse,
  parseUuid,
  requireIdempotencyKey,
  withRoute,
} from "@/server/http";

export const runtime = "nodejs";

/**
 * P4.2 Task 4 (ADR-0028 amendment): a user-triggered safe retry for a
 * confirmation stuck `pending` -- re-drives `reconcileScanConfirmation`
 * directly against durably stored data rather than touching the queue. Safe
 * to call repeatedly (including while the normal pipeline is still working
 * in the background): every hop it can trigger is idempotent.
 */
export const POST = withRoute(
  "scans.confirm.retry",
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

    const record = await reconcileScanConfirmation(
      context.database.scan,
      context.database.core,
      { userId, scanId },
    );

    return jsonResponse(
      ConfirmScanResponseSchema.parse({ ...record, scanId }),
      200,
      requestId,
    );
  },
);
