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
  validateCropGeometry,
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
    const image = await getImageUploadForUser(context.database.scan, lookup);

    if (image.completedAt) {
      return completedResponse(image, requestId);
    }

    const uploadPhaseStartedAt = Date.now();
    let validated;
    let stored;
    let analysisBytes: Uint8Array;
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
      analysisBytes = stored.bytes;
      if (image.cropProvenance) {
        const crop = image.cropProvenance;
        validateCropGeometry(crop, validated);
        const cropStored = await context.storage.readObject(
          deriveImageObjectKey(lookup, "crop"),
          MAX_IMAGE_SIZE_BYTES,
        );
        const cropValidated = await validateImage({
          bytes: cropStored.bytes,
          storedContentType: cropStored.contentType,
          expectedMimeType: crop.mimeType,
          expectedSizeBytes: crop.sizeBytes,
          expectedChecksumSha256: crop.checksumSha256,
        });
        if (
          cropValidated.width !== crop.width ||
          cropValidated.height !== crop.height
        ) {
          throw new ImageValidationError(
            "invalid_image",
            "The crop dimensions do not match its declared dimensions.",
          );
        }
        analysisBytes = cropStored.bytes;
      }
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
    const normalized = await normalizeImage(analysisBytes);
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

    const completed = await completeImageUpload(context.database.scan, {
      ...lookup,
      width: validated.width,
      height: validated.height,
      analysisSizeBytes: normalized.analysis.sizeBytes,
      analysisWidth: normalized.analysis.width,
      analysisHeight: normalized.analysis.height,
      thumbnailSizeBytes: normalized.thumbnail.sizeBytes,
    });
    // JSON.stringify'd as one call, not `console.info(prefix, obj)` — see
    // the comment on `logHttpEvent` in `@/server/http` for why: a
    // multi-field object otherwise prints across several lines, and each
    // becomes a separate CloudWatch log event.
    console.info(
      JSON.stringify({
        event: "upload_complete_timing",
        scanId,
        imageId,
        requestId,
        correlationId,
        uploadPhaseDurationMs,
        normalizationPhaseDurationMs,
      }),
    );
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
    cropProvenance: unknown;
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
    analysisSource: image.cropProvenance ? "crop" : "source",
  });
  return jsonResponse(response, 200, requestId);
}
