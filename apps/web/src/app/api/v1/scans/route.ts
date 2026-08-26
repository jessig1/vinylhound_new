import {
  ACCEPTED_IMAGE_MIME_TYPES,
  CreateScanRequestSchema,
  CreateScanResponseSchema,
  MAX_IMAGES_PER_SCAN,
  MAX_IMAGE_SIZE_BYTES,
} from "@vinylhound/contracts";
import { createOrGetScan, ensureDevelopmentUser } from "@vinylhound/database";

import { getServerContext } from "@/server/context";
import {
  createRequestId,
  errorResponse,
  jsonResponse,
  parseJson,
  requireIdempotencyKey,
} from "@/server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    const idempotencyKey = requireIdempotencyKey(request);
    const input = await parseJson(request, CreateScanRequestSchema);
    const context = getServerContext();
    const userId = context.config.DEVELOPMENT_USER_ID;

    await ensureDevelopmentUser(context.database.db, userId);
    const result = await createOrGetScan(context.database.db, {
      userId,
      source: input.source,
      idempotencyKey,
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
