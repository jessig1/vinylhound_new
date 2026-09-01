import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { ApiErrorSchema, IdempotencyKeySchema } from "@vinylhound/contracts";
import { CatalogProviderError } from "@vinylhound/catalog";
import { DatabaseCommandError } from "@vinylhound/database";
import {
  ImageValidationError,
  StoredObjectNotFoundError,
  StoredObjectTooLargeError,
} from "@vinylhound/storage";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function createRequestId() {
  return randomUUID();
}

export async function parseJson<T>(request: Request, schema: z.ZodType<T>) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "invalid_json", "Expected a valid JSON body.");
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError(
      400,
      "invalid_request",
      "The request body did not match the expected schema.",
    );
  }
  return result.data;
}

export function requireIdempotencyKey(request: Request) {
  const result = IdempotencyKeySchema.safeParse(
    request.headers.get("idempotency-key"),
  );
  if (!result.success) {
    throw new HttpError(
      400,
      "invalid_idempotency_key",
      "A non-empty Idempotency-Key header of at most 255 characters is required.",
    );
  }
  return result.data;
}

export function parseUuid(value: string, label: string) {
  const result = z.string().uuid().safeParse(value);
  if (!result.success) {
    throw new HttpError(400, "invalid_identifier", `${label} must be a UUID.`);
  }
  return result.data;
}

export function jsonResponse(body: unknown, status: number, requestId: string) {
  return NextResponse.json(body, {
    status,
    headers: { "x-request-id": requestId },
  });
}

export function errorResponse(error: unknown, requestId: string) {
  if (error instanceof HttpError) {
    return createError(error.status, error.code, error.message, requestId);
  }
  if (error instanceof z.ZodError) {
    console.error(
      `[web] internal schema validation failed; requestId=${requestId}`,
      error.issues.map(({ code, path }) => ({ code, path })),
    );
    return createError(
      500,
      "internal_error",
      "The request could not be completed.",
      requestId,
    );
  }
  if (error instanceof DatabaseCommandError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "quota_exceeded"
          ? 429
          : 409;
    return createError(status, error.code, error.message, requestId);
  }
  if (error instanceof CatalogProviderError) {
    return createError(
      error.category === "rate_limit" ? 429 : 502,
      `catalog_${error.category}`,
      error.message,
      requestId,
    );
  }
  if (error instanceof ImageValidationError) {
    return createError(422, error.code, error.message, requestId);
  }
  if (error instanceof StoredObjectTooLargeError) {
    return createError(
      422,
      "file_too_large",
      "The uploaded object exceeds the allowed size.",
      requestId,
    );
  }
  if (error instanceof StoredObjectNotFoundError) {
    return createError(
      409,
      "upload_missing",
      "The image has not been uploaded to object storage.",
      requestId,
    );
  }

  return createError(
    500,
    "internal_error",
    "The request could not be completed.",
    requestId,
  );
}

function createError(
  status: number,
  code: string,
  message: string,
  requestId: string,
) {
  const body = ApiErrorSchema.parse({
    error: { code, message, requestId },
  });
  return jsonResponse(body, status, requestId);
}
