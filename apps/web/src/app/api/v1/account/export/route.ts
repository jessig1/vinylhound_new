import { AccountExportResponseSchema } from "@vinylhound/contracts";
import { getAccountExportForUser } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { jsonResponse, withRoute } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRoute(
  "account.export",
  async (_request, { requestId }) => {
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
  },
);
