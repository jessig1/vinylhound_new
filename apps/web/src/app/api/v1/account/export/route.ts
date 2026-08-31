import { AccountExportResponseSchema } from "@vinylhound/contracts";
import { getAccountExportForUser } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { createRequestId, errorResponse, jsonResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const requestId = createRequestId();
  try {
    const context = getServerContext();
    const userId = await requireUserId(context);
    const result = await getAccountExportForUser(context.database.db, {
      userId,
    });

    const response = jsonResponse(
      AccountExportResponseSchema.parse(result),
      200,
      requestId,
    );
    response.headers.set("cache-control", "no-store");
    response.headers.set(
      "content-disposition",
      'attachment; filename="vinylhound-account-export.json"',
    );
    return response;
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
