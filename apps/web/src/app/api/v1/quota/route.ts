import { GetQuotaHeadroomResponseSchema } from "@vinylhound/contracts";
import { getScanQuotaHeadroomForUser } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { jsonResponse, withRoute } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Advisory only: this read takes no per-user lock, so it can be stale under
// concurrency. The client uses it to decide whether to start expensive
// upload work; submitScan/retryScan remain the sole authoritative gate.
export const GET = withRoute("quota.get", async (_request, { requestId }) => {
  const context = getServerContext();
  const userId = await requireUserId(context);

  const headroom = await getScanQuotaHeadroomForUser(context.database.db, {
    userId,
    limits: {
      dailyAnalysisLimit: context.config.USER_DAILY_ANALYSIS_LIMIT,
      activeScanLimit: context.config.USER_ACTIVE_SCAN_LIMIT,
      monthlySpendLimitUsd: context.config.USER_MONTHLY_SPEND_LIMIT_USD,
      scanCostReservationUsd: context.config.SCAN_COST_RESERVATION_USD,
    },
  });

  const response = jsonResponse(
    GetQuotaHeadroomResponseSchema.parse({
      checkedAt: headroom.checkedAt.toISOString(),
      limits: headroom.limits,
      dailyAnalysis: headroom.dailyAnalysis,
      activeScans: headroom.activeScans,
      monthlySpend: headroom.monthlySpend,
      admissible: headroom.admissible,
      blockedBy: headroom.blockedBy,
    }),
    200,
    requestId,
  );
  response.headers.set("cache-control", "no-store");
  return response;
});
