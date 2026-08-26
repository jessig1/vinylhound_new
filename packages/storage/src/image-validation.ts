import { createHash } from "node:crypto";

import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";

import type { ImageMimeType } from "@vinylhound/contracts";

const MAX_IMAGE_PIXELS = 25_000_000;

export type ImageValidationErrorCode =
  | "animated_image"
  | "checksum_mismatch"
  | "invalid_image"
  | "mime_mismatch"
  | "size_mismatch";

export class ImageValidationError extends Error {
  constructor(
    readonly code: ImageValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ImageValidationError";
  }
}

export interface ValidateImageInput {
  bytes: Uint8Array;
  storedContentType: string | undefined;
  expectedMimeType: ImageMimeType;
  expectedSizeBytes: number;
  expectedChecksumSha256: string;
}

export async function validateImage(input: ValidateImageInput) {
  if (input.bytes.byteLength !== input.expectedSizeBytes) {
    throw new ImageValidationError(
      "size_mismatch",
      "The uploaded file size does not match the declared size.",
    );
  }
  if (
    input.storedContentType &&
    input.storedContentType !== input.expectedMimeType
  ) {
    throw new ImageValidationError(
      "mime_mismatch",
      "The uploaded Content-Type does not match the declared image type.",
    );
  }

  const checksum = createHash("sha256").update(input.bytes).digest("hex");
  if (checksum !== input.expectedChecksumSha256) {
    throw new ImageValidationError(
      "checksum_mismatch",
      "The uploaded file checksum does not match the declared checksum.",
    );
  }

  const detectedType = await fileTypeFromBuffer(input.bytes);
  if (!detectedType || detectedType.mime !== input.expectedMimeType) {
    throw new ImageValidationError(
      "mime_mismatch",
      "The decoded file type does not match the declared image type.",
    );
  }

  try {
    const metadata = await sharp(input.bytes, {
      animated: true,
      failOn: "warning",
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).metadata();

    if (!metadata.width || !metadata.height) {
      throw new ImageValidationError(
        "invalid_image",
        "The image does not contain valid dimensions.",
      );
    }
    if ((metadata.pages ?? 1) > 1) {
      throw new ImageValidationError(
        "animated_image",
        "Animated images are not supported.",
      );
    }

    await sharp(input.bytes, {
      failOn: "warning",
      limitInputPixels: MAX_IMAGE_PIXELS,
    })
      .rotate()
      .toBuffer();

    return {
      mimeType: input.expectedMimeType,
      sizeBytes: input.bytes.byteLength,
      checksumSha256: checksum,
      width: metadata.width,
      height: metadata.height,
    };
  } catch (error) {
    if (error instanceof ImageValidationError) {
      throw error;
    }
    throw new ImageValidationError(
      "invalid_image",
      "The uploaded bytes could not be decoded as a valid image.",
    );
  }
}
