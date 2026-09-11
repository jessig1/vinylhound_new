import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  ApiErrorSchema,
  CORRELATION_ID_HEADER,
  CorrelationIdSchema,
  IdempotencyKeySchema,
} from "@vinylhound/contracts";
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

/**
 * Reads the inbound correlation ID, if the caller sent one. This is
 * untrusted metadata forwarded onto the outbox row, job payload, and worker
 * attempt purely so a caller-supplied trace value can be grepped end to end
 * — never used for identity, lookups, or authorization. An absent or
 * malformed value is dropped rather than rejecting the request.
 */
export function parseCorrelationId(request: Request): string | undefined {
  const header = request.headers.get(CORRELATION_ID_HEADER);
  if (header === null) {
    return undefined;
  }
  const result = CorrelationIdSchema.safeParse(header);
  return result.success ? result.data : undefined;
}

export interface RequestContext {
  requestId: string;
  correlationId?: string;
}

export function logHttpEvent(fields: {
  route: string;
  method: string;
  status: number;
  durationMs: number;
  requestId: string;
  correlationId?: string;
}) {
  console.info("[web] http_request", fields);
}

/**
 * Wraps a route handler with a shared request ID, an inbound correlation ID
 * (if any), and structured request/error timing, so every `apps/web` API
 * route logs one consistent line instead of each repeating its own
 * try/catch and requestId plumbing.
 */
export function withRoute<Rest extends unknown[]>(
  routeName: string,
  handler: (
    request: Request,
    context: RequestContext,
    ...rest: Rest
  ) => Promise<Response>,
) {
  return async (request: Request, ...rest: Rest): Promise<Response> => {
    const requestId = createRequestId();
    const correlationId = parseCorrelationId(request);
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await handler(request, { requestId, correlationId }, ...rest);
    } catch (error) {
      response = errorResponse(error, requestId);
    }
    logHttpEvent({
      route: routeName,
      method: request.method,
      status: response.status,
      durationMs: Date.now() - startedAt,
      requestId,
      correlationId,
    });
    return response;
  };
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
    const status =
      error.category === "rate_limit"
        ? 429
        : error.category === "not_found"
          ? 404
          : 502;
    return createError(
      status,
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
