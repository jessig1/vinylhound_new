import {
  SIGNED_IMAGE_READ_TTL_SECONDS,
  SignedImageReadSchema,
} from "@vinylhound/contracts";
import {
  deriveImageObjectKey,
  getImageUploadForUser,
} from "@vinylhound/database";

import { requireUserId } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { HttpError, jsonResponse, parseUuid, withRoute } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRoute(
  "scans.images.thumbnail",
  async (
    _request,
    { requestId },
    route: { params: Promise<{ scanId: string; imageId: string }> },
  ) => {
    const { scanId: rawScanId, imageId: rawImageId } = await route.params;
    const scanId = parseUuid(rawScanId, "scanId");
    const imageId = parseUuid(rawImageId, "imageId");
    const context = getServerContext();
    const userId = await requireUserId(context);
    const image = await getImageUploadForUser(context.database.db, {
      userId,
      scanId,
      imageId,
    });

    if (!image.completedAt) {
      throw new HttpError(
        404,
        "thumbnail_unavailable",
        "Thumbnail is not ready.",
      );
    }

    const isFallback = image.thumbnailSizeBytes === null;
    const objectKey = isFallback
      ? image.objectKey
      : deriveImageObjectKey({ userId, scanId, imageId }, "thumbnail");
    const expiresAt = new Date(
      Date.now() + SIGNED_IMAGE_READ_TTL_SECONDS * 1_000,
    );
    const body = SignedImageReadSchema.parse({
      url: await context.storage.createSignedReadUrl(
        objectKey,
        SIGNED_IMAGE_READ_TTL_SECONDS,
      ),
      expiresAt: expiresAt.toISOString(),
      isFallback,
    });
    const response = jsonResponse(body, 200, requestId);
    response.headers.set("cache-control", "private, no-store");
    return response;
  },
);
