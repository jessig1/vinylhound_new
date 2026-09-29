import {
  CreateImageUploadRequestSchema,
  MAX_IMAGES_PER_SCAN,
  SignedUploadSchema,
} from "@vinylhound/contracts";
import {
  createOrGetImageUpload,
  deriveImageObjectKey,
} from "@vinylhound/database";

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

    const result = await createOrGetImageUpload(context.database.scan, {
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
    const crop = result.record.cropProvenance;
    const cropSigned = crop
      ? await context.storage.createSignedUpload({
          objectKey: deriveImageObjectKey(
            { userId, scanId, imageId: result.record.id },
            "crop",
          ),
          mimeType: "image/jpeg",
          sizeBytes: crop.sizeBytes,
          checksumSha256: crop.checksumSha256,
        })
      : null;
    const response = SignedUploadSchema.parse({
      imageId: result.record.id,
      method: signed.method,
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      requiredHeaders: signed.requiredHeaders,
      ...(cropSigned
        ? {
            cropUpload: {
              method: cropSigned.method,
              url: cropSigned.url,
              expiresAt: cropSigned.expiresAt.toISOString(),
              requiredHeaders: cropSigned.requiredHeaders,
            },
          }
        : {}),
    });

    return jsonResponse(response, result.created ? 201 : 200, requestId);
  },
);
