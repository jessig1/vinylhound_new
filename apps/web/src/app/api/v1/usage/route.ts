import {
  GetUsageSummaryResponseSchema,
  USAGE_SUMMARY_WINDOW_DAYS,
} from "@vinylhound/contracts";
import { getUsageSummaryForUser } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { jsonResponse, withRoute } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRoute("usage.get", async (_request, { requestId }) => {
  const context = getServerContext();
  const userId = await requireUserId(context);
  const since = new Date(
    Date.now() - USAGE_SUMMARY_WINDOW_DAYS * 24 * 60 * 60 * 1_000,
  );

  const summary = await getUsageSummaryForUser(context.database.db, {
    userId,
    since,
  });

  const response = jsonResponse(
    GetUsageSummaryResponseSchema.parse({
      windowDays: USAGE_SUMMARY_WINDOW_DAYS,
      since: since.toISOString(),
      scanCount: summary.scanCount,
      outcomes: {
        identified: summary.outcomes.identified,
        needsReview: summary.outcomes.needsReview,
        unresolved: summary.outcomes.unresolved,
        failed: summary.outcomes.failed,
        canceled: summary.outcomes.canceled,
        inProgress: summary.outcomes.inProgress,
      },
      cost: summary.cost,
    }),
    200,
    requestId,
  );
  response.headers.set("cache-control", "no-store");
  return response;
});
