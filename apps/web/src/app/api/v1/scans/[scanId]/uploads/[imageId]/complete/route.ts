import {
  CompleteImageUploadResponseSchema,
  MAX_IMAGE_SIZE_BYTES,
} from "@vinylhound/contracts";
import {
  completeImageUpload,
  getImageUploadForUser,
} from "@vinylhound/database";
import {
  ImageValidationError,
  StoredObjectTooLargeError,
  validateImage,
} from "@vinylhound/storage";

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
    const lookup = {
      userId: context.config.DEVELOPMENT_USER_ID,
      scanId,
      imageId,
    };
    const image = await getImageUploadForUser(context.database.db, lookup);

    if (image.completedAt) {
      return completedResponse(image, requestId);
    }

    let validated;
    try {
      const stored = await context.storage.readObject(
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

    const completed = await completeImageUpload(context.database.db, {
      ...lookup,
      width: validated.width,
      height: validated.height,
    });
    return completedResponse(completed, requestId);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

function completedResponse(
  image: {
    id: string;
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
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    width: image.width,
    height: image.height,
  });
  return jsonResponse(response, 200, requestId);
}
