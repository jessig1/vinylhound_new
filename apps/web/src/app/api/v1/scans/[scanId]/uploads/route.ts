import {
  CreateImageUploadRequestSchema,
  MAX_IMAGES_PER_SCAN,
  SignedUploadSchema,
} from "@vinylhound/contracts";
import { createOrGetImageUpload } from "@vinylhound/database";

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
  "scans.uploads.create",
  async (
    request,
    { requestId },
    route: { params: Promise<{ scanId: string }> },
  ) => {
    const { scanId: rawScanId } = await route.params;
    const scanId = parseUuid(rawScanId, "scanId");
    const idempotencyKey = requireIdempotencyKey(request);
    const input = await parseJson(request, CreateImageUploadRequestSchema);
    const context = getServerContext();
    const userId = await requireUserId(context);

    const result = await createOrGetImageUpload(context.database.db, {
      userId,
      scanId,
      idempotencyKey,
      ...input,
      maxImages: MAX_IMAGES_PER_SCAN,
    });
    const signed = await context.storage.createSignedUpload({
      objectKey: result.record.objectKey,
      mimeType: result.record.mimeType,
      sizeBytes: result.record.sizeBytes,
      checksumSha256: result.record.checksumSha256,
    });
    const response = SignedUploadSchema.parse({
      imageId: result.record.id,
      method: signed.method,
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      requiredHeaders: signed.requiredHeaders,
    });

    return jsonResponse(response, result.created ? 201 : 200, requestId);
  },
);
