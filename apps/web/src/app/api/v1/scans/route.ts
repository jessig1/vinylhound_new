import {
  ACCEPTED_IMAGE_MIME_TYPES,
  CreateScanRequestSchema,
  CreateScanResponseSchema,
  ListScansResponseSchema,
  MAX_IMAGES_PER_SCAN,
  MAX_IMAGE_SIZE_BYTES,
  MAX_SCANS_PER_PAGE,
} from "@vinylhound/contracts";
import { createOrGetScan, listScansForUser } from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import {
  createRequestId,
  errorResponse,
  HttpError,
  jsonResponse,
  parseJson,
  requireIdempotencyKey,
} from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = createRequestId();
  try {
    const context = getServerContext();
    const cursor = new URL(request.url).searchParams.get("cursor");
    const before = cursor ? new Date(cursor) : undefined;
    if (before && Number.isNaN(before.getTime())) {
      throw new HttpError(
        400,
        "invalid_cursor",
        "The cursor is not a valid timestamp.",
      );
    }

    const userId = await requireUserId(context);
    const { summaries, nextCursor } = await listScansForUser(
      context.database.db,
      {
        userId,
        limit: MAX_SCANS_PER_PAGE,
        before,
      },
    );

    const response = jsonResponse(
      ListScansResponseSchema.parse({
        scans: summaries,
        nextCursor: nextCursor ? nextCursor.toISOString() : null,
      }),
      200,
      requestId,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    const idempotencyKey = requireIdempotencyKey(request);
    const input = await parseJson(request, CreateScanRequestSchema);
    const context = getServerContext();
    const userId = await requireUserId(context);

    const result = await createOrGetScan(context.database.db, {
      userId,
      source: input.source,
      idempotencyKey,
      batchId: input.batchId,
      quotaLimits: {
        dailyAnalysisLimit: context.config.USER_DAILY_ANALYSIS_LIMIT,
        activeScanLimit: context.config.USER_ACTIVE_SCAN_LIMIT,
        monthlySpendLimitUsd: context.config.USER_MONTHLY_SPEND_LIMIT_USD,
        scanCostReservationUsd: context.config.SCAN_COST_RESERVATION_USD,
      },
    });
    const response = CreateScanResponseSchema.parse({
      scanId: result.record.id,
      status: "awaiting_upload",
      limits: {
        acceptedMimeTypes: [...ACCEPTED_IMAGE_MIME_TYPES],
        maxImages: MAX_IMAGES_PER_SCAN,
        maxImageSizeBytes: MAX_IMAGE_SIZE_BYTES,
      },
    });

    return jsonResponse(response, result.created ? 201 : 200, requestId);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
