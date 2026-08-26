import { z } from "zod";

export const ACCEPTED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export const MAX_IMAGES_PER_SCAN = 12;
export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
export const SIGNED_UPLOAD_TTL_SECONDS = 5 * 60;

export const ImageMimeTypeSchema = z.enum(ACCEPTED_IMAGE_MIME_TYPES);

export const IMAGE_SNIFF_BYTE_LENGTH = 16;

export type DetectedImageType =
  | { kind: "supported"; mimeType: ImageMimeType }
  | { kind: "heif_like" }
  | { kind: "unknown" };

const HEIF_LIKE_BRANDS = [
  "heic",
  "heix",
  "hevc",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
  "avif",
  "avis",
] as const;

/**
 * Detects the actual image format from leading magic bytes. Browsers derive
 * `File.type` from the filename extension, so the declared upload MIME type
 * must come from content, or a misnamed file fails server-side validation
 * after a full upload.
 */
export function detectImageMimeType(bytes: Uint8Array): DetectedImageType {
  if (matchesBytes(bytes, 0, [0xff, 0xd8, 0xff])) {
    return { kind: "supported", mimeType: "image/jpeg" };
  }
  if (
    matchesBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return { kind: "supported", mimeType: "image/png" };
  }
  if (matchesAscii(bytes, 0, "GIF87a") || matchesAscii(bytes, 0, "GIF89a")) {
    return { kind: "supported", mimeType: "image/gif" };
  }
  if (matchesAscii(bytes, 0, "RIFF") && matchesAscii(bytes, 8, "WEBP")) {
    return { kind: "supported", mimeType: "image/webp" };
  }
  if (matchesAscii(bytes, 4, "ftyp")) {
    const brand = asciiAt(bytes, 8, 4);
    if (HEIF_LIKE_BRANDS.some((known) => known === brand)) {
      return { kind: "heif_like" };
    }
  }
  return { kind: "unknown" };
}

function matchesBytes(
  bytes: Uint8Array,
  offset: number,
  expected: readonly number[],
): boolean {
  if (bytes.byteLength < offset + expected.length) {
    return false;
  }
  return expected.every((value, index) => bytes[offset + index] === value);
}

function matchesAscii(
  bytes: Uint8Array,
  offset: number,
  expected: string,
): boolean {
  return asciiAt(bytes, offset, expected.length) === expected;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.byteLength < offset + length) {
    return "";
  }
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
export const Sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Expected a lowercase hexadecimal SHA-256 digest.");
export const IdempotencyKeySchema = z.string().trim().min(1).max(255);

export const CreateImageUploadRequestSchema = z
  .object({
    filename: z.string().trim().min(1).max(255),
    mimeType: ImageMimeTypeSchema,
    sizeBytes: z.number().int().positive().max(MAX_IMAGE_SIZE_BYTES),
    checksumSha256: Sha256Schema,
  })
  .strict();

export const SignedUploadSchema = z
  .object({
    imageId: z.string().uuid(),
    method: z.literal("PUT"),
    url: z.url(),
    expiresAt: z.string().datetime(),
    requiredHeaders: z.record(z.string(), z.string()),
  })
  .strict();

export const CompleteImageUploadResponseSchema = z
  .object({
    imageId: z.string().uuid(),
    status: z.literal("completed"),
    mimeType: ImageMimeTypeSchema,
    sizeBytes: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

export const ApiErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        requestId: z.string().uuid(),
      })
      .strict(),
  })
  .strict();

export type ImageMimeType = z.infer<typeof ImageMimeTypeSchema>;
export type CreateImageUploadRequest = z.infer<
  typeof CreateImageUploadRequestSchema
>;
export type SignedUpload = z.infer<typeof SignedUploadSchema>;
export type CompleteImageUploadResponse = z.infer<
  typeof CompleteImageUploadResponseSchema
>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
