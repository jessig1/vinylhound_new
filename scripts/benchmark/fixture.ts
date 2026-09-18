import { createHash } from "node:crypto";

import sharp from "sharp";

export interface ImageFixture {
  bytes: Buffer;
  sizeBytes: number;
  checksumSha256: string;
  mimeType: "image/jpeg";
}

let cached: ImageFixture | undefined;

/**
 * A small, real, sharp-decodable JPEG reused for every synthetic upload.
 * validateImage (packages/storage/src/image-validation.ts) requires a file
 * that actually decodes and matches its declared type/size/checksum, so a
 * placeholder buffer of random bytes would fail every upload; every scan in
 * this benchmark reuses the exact same bytes since only the pipeline's
 * timing is under measurement, not image content.
 */
export async function loadImageFixture(): Promise<ImageFixture> {
  if (cached) {
    return cached;
  }
  const bytes = await sharp({
    create: {
      width: 600,
      height: 600,
      channels: 3,
      background: { r: 120, g: 90, b: 200 },
    },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  cached = {
    bytes,
    sizeBytes: bytes.byteLength,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    mimeType: "image/jpeg",
  };
  return cached;
}
