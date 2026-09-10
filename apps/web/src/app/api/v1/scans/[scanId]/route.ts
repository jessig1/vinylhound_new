import { GetScanResponseSchema } from "@vinylhound/contracts";
import { getScanForUser } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { jsonResponse, parseUuid, withRoute } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRoute(
  "scans.get",
  async (
    _request,
    { requestId },
    route: { params: Promise<{ scanId: string }> },
  ) => {
    const { scanId: rawScanId } = await route.params;
    const scanId = parseUuid(rawScanId, "scanId");
    const context = getServerContext();
    const userId = await requireUserId(context);
    const result = await getScanForUser(context.database.db, {
      userId,
      scanId,
    });

    const response = jsonResponse(
      GetScanResponseSchema.parse(result),
      200,
      requestId,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  },
);
