import { GetScanResponseSchema } from "@vinylhound/contracts";
import { getScanForUser } from "@vinylhound/database";

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
  route: { params: Promise<{ scanId: string }> },
) {
  const requestId = createRequestId();
  try {
    const { scanId: rawScanId } = await route.params;
    const scanId = parseUuid(rawScanId, "scanId");
    const context = getServerContext();
    const result = await getScanForUser(context.database.db, {
      userId: context.config.DEVELOPMENT_USER_ID,
      scanId,
    });

    const response = jsonResponse(
      GetScanResponseSchema.parse(result),
      200,
      requestId,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
