import {
  ConfirmScanRequestSchema,
  ConfirmScanResponseSchema,
} from "@vinylhound/contracts";
import { confirmScan } from "@vinylhound/database";

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

export const POST = withRoute(
  "scans.confirm",
  async (
    request,
    { requestId },
    route: { params: Promise<{ scanId: string }> },
  ) => {
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
  },
);
