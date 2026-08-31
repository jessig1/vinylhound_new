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
  createRequestId,
  errorResponse,
  jsonResponse,
  parseUuid,
  requireIdempotencyKey,
} from "@/server/http";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  route: { params: Promise<{ scanId: string; imageId: string }> },
) {
  const requestId = createRequestId();
  try {
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

    const completed = await completeImageUpload(context.database.db, {
      ...lookup,
      width: validated.width,
      height: validated.height,
      analysisSizeBytes: normalized.analysis.sizeBytes,
      analysisWidth: normalized.analysis.width,
      analysisHeight: normalized.analysis.height,
      thumbnailSizeBytes: normalized.thumbnail.sizeBytes,
    });
    return completedResponse(completed, requestId);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

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
