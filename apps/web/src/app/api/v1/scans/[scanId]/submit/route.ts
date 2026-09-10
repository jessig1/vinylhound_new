import { SubmitScanResponseSchema } from "@vinylhound/contracts";
import { submitScan } from "@vinylhound/database";

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
  "scans.submit",
  async (
    request,
    { requestId, correlationId },
    route: { params: Promise<{ scanId: string }> },
  ) => {
    const { scanId: rawScanId } = await route.params;
    const scanId = parseUuid(rawScanId, "scanId");
    const idempotencyKey = requireIdempotencyKey(request);
    const context = getServerContext();
    const userId = await requireUserId(context);

    const result = await submitScan(context.database.db, {
      userId,
      scanId,
      idempotencyKey,
      correlationId,
      quotaLimits: {
        dailyAnalysisLimit: context.config.USER_DAILY_ANALYSIS_LIMIT,
        activeScanLimit: context.config.USER_ACTIVE_SCAN_LIMIT,
        monthlySpendLimitUsd: context.config.USER_MONTHLY_SPEND_LIMIT_USD,
        scanCostReservationUsd: context.config.SCAN_COST_RESERVATION_USD,
      },
    });
    const response = SubmitScanResponseSchema.parse({
      scanId: result.record.id,
      status: result.record.status,
      attemptNumber: result.job.attemptNumber,
      jobId: result.jobId,
    });

    return jsonResponse(response, result.created ? 202 : 200, requestId);
  },
);
