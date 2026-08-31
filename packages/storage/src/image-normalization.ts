import sharp from "sharp";

const ANALYSIS_MAX_DIMENSION = 2048;
const ANALYSIS_JPEG_QUALITY = 82;
const THUMBNAIL_MAX_DIMENSION = 400;
const THUMBNAIL_JPEG_QUALITY = 70;

export interface NormalizedImage {
  bytes: Uint8Array;
  mimeType: "image/jpeg";
  sizeBytes: number;
  width: number;
  height: number;
}

export interface NormalizeImageResult {
  analysis: NormalizedImage;
  thumbnail: NormalizedImage;
}

/**
 * Derives a downsized, provider-ready analysis copy and a small UI
 * thumbnail from validated, decoded image bytes. Re-encodes to JPEG
 * regardless of source format so downstream consumers (the AI adapter,
 * future previews) handle one predictable format.
 */
export async function normalizeImage(
  bytes: Uint8Array,
): Promise<NormalizeImageResult> {
  const [analysis, thumbnail] = await Promise.all([
    resizeToJpeg(bytes, ANALYSIS_MAX_DIMENSION, ANALYSIS_JPEG_QUALITY),
    resizeToJpeg(bytes, THUMBNAIL_MAX_DIMENSION, THUMBNAIL_JPEG_QUALITY),
  ]);
  return { analysis, thumbnail };
}

async function resizeToJpeg(
  bytes: Uint8Array,
  maxDimension: number,
  quality: number,
): Promise<NormalizedImage> {
  const resized = sharp(bytes, { failOn: "warning" })
    .rotate()
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality });

  const { data, info } = await resized.toBuffer({ resolveWithObject: true });

  return {
    bytes: data,
    mimeType: "image/jpeg",
    sizeBytes: data.byteLength,
    width: info.width,
    height: info.height,
  };
}
