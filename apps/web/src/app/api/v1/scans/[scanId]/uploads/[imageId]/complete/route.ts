import {
  CompleteImageUploadResponseSchema,
  MAX_IMAGE_SIZE_BYTES,
} from "@vinylhound/contracts";
import {
  completeImageUpload,
  deriveImageObjectKey,
  getImageUploadForUser,
} from "@vinylhound/database";
import {
  ImageValidationError,
  normalizeImage,
  StoredObjectTooLargeError,
  validateImage,
} from "@vinylhound/storage";

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
  "scans.uploads.complete",
  async (
    request,
    { requestId, correlationId },
    route: { params: Promise<{ scanId: string; imageId: string }> },
  ) => {
    requireIdempotencyKey(request);
    const params = await route.params;
    const scanId = parseUuid(params.scanId, "scanId");
    const imageId = parseUuid(params.imageId, "imageId");
    const context = getServerContext();
    const userId = await requireUserId(context);
    const lookup = {
      userId,
      scanId,
      imageId,
    };
    const image = await getImageUploadForUser(context.database.db, lookup);

    if (image.completedAt) {
      return completedResponse(image, requestId);
    }

    const uploadPhaseStartedAt = Date.now();
    let validated;
    let stored;
    try {
      stored = await context.storage.readObject(
        image.objectKey,
        MAX_IMAGE_SIZE_BYTES,
      );
      validated = await validateImage({
        bytes: stored.bytes,
        storedContentType: stored.contentType,
        expectedMimeType: image.mimeType,
        expectedSizeBytes: image.sizeBytes,
        expectedChecksumSha256: image.checksumSha256,
      });
    } catch (error) {
      if (
        error instanceof ImageValidationError ||
        error instanceof StoredObjectTooLargeError
      ) {
        await context.storage.deleteObject(image.objectKey);
      }
      throw error;
    }
    const uploadPhaseDurationMs = Date.now() - uploadPhaseStartedAt;

    const normalizationPhaseStartedAt = Date.now();
    const normalized = await normalizeImage(stored.bytes);
    await Promise.all([
      context.storage.putObject({
        objectKey: deriveImageObjectKey(lookup, "analysis"),
        bytes: normalized.analysis.bytes,
        contentType: normalized.analysis.mimeType,
      }),
      context.storage.putObject({
        objectKey: deriveImageObjectKey(lookup, "thumbnail"),
        bytes: normalized.thumbnail.bytes,
        contentType: normalized.thumbnail.mimeType,
      }),
    ]);
    const normalizationPhaseDurationMs =
      Date.now() - normalizationPhaseStartedAt;

    const completed = await completeImageUpload(context.database.db, {
      ...lookup,
      width: validated.width,
      height: validated.height,
      analysisSizeBytes: normalized.analysis.sizeBytes,
      analysisWidth: normalized.analysis.width,
      analysisHeight: normalized.analysis.height,
      thumbnailSizeBytes: normalized.thumbnail.sizeBytes,
    });
    console.info("[web] upload_complete_timing", {
      scanId,
      imageId,
      requestId,
      correlationId,
      uploadPhaseDurationMs,
      normalizationPhaseDurationMs,
    });
    return completedResponse(completed, requestId);
  },
);

function completedResponse(
  image: {
    id: string;
    viewType:
      "front" | "back" | "spine" | "label" | "barcode" | "runout" | "other";
    mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
    sizeBytes: number;
    width: number | null;
    height: number | null;
  },
  requestId: string,
) {
  const response = CompleteImageUploadResponseSchema.parse({
    imageId: image.id,
    status: "completed",
    viewType: image.viewType,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    width: image.width,
    height: image.height,
  });
  return jsonResponse(response, 200, requestId);
}
