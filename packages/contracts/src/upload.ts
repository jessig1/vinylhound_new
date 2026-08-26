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
