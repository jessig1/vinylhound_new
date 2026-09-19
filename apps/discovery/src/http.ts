import { randomUUID } from "node:crypto";

import { ApiErrorSchema, CORRELATION_ID_HEADER } from "@vinylhound/contracts";
import {
  catalogProviderErrorStatus,
  discoveryProviderErrorStatus,
  isCatalogProviderError,
  isDiscoveryProviderError,
} from "@vinylhound/catalog";
import {
  parseServiceAuthHeader,
  verifyServiceRequest,
  ServiceAuthError,
} from "@vinylhound/service-auth";

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

/**
 * The service-identity + user-authorization boundary this whole app exists
 * for (ADR-0025, P4.1 Task 2): every route but `/healthz` requires a token
 * only a holder of `sharedSecret` could have signed, binding a specific
 * `userId`. A missing, malformed, expired, or wrongly-signed token is always
 * 401 — this deliberately does not distinguish "no token" from "wrong
 * secret" in the response, since either tells an unauthorized caller more
 * than it should learn about why it failed.
 */
export function requireServiceUserId(
  request: Request,
  sharedSecret: string,
): string {
  const token = parseServiceAuthHeader(request.headers.get("authorization"));
  try {
    return verifyServiceRequest(sharedSecret, token).userId;
  } catch (error) {
    if (error instanceof ServiceAuthError) {
      throw new HttpError(
        401,
        "unauthenticated",
        "A valid service authorization token is required.",
      );
    }
    throw error;
  }
}

export function createRequestId() {
  return randomUUID();
}

export function parseCorrelationId(request: Request): string | undefined {
  return request.headers.get(CORRELATION_ID_HEADER) ?? undefined;
}

function logHttpEvent(fields: {
  route: string;
  method: string;
  status: number;
  durationMs: number;
  requestId: string;
  correlationId?: string;
}) {
  // Single JSON.stringify call, matching apps/web's `logHttpEvent` and
  // apps/worker's timing lines — see docs/OPERATIONS.md's P3.5 Task 3 note
  // on why a multi-arg console.info call defeats Logs Insights here.
  console.info(JSON.stringify({ event: "http_request", ...fields }));
}

export interface RequestContext {
  requestId: string;
  correlationId?: string;
}

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

export function jsonResponse(body: unknown, status: number, requestId: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
    },
  });
}

function createError(
  status: number,
  code: string,
  message: string,
  requestId: string,
) {
  const body = ApiErrorSchema.parse({ error: { code, message, requestId } });
  return jsonResponse(body, status, requestId);
}

export function errorResponse(error: unknown, requestId: string) {
  if (error instanceof HttpError) {
    return createError(error.status, error.code, error.message, requestId);
  }
  if (isCatalogProviderError(error)) {
    return createError(
      catalogProviderErrorStatus(error.category),
      `catalog_${error.category}`,
      error.message,
      requestId,
    );
  }
  if (isDiscoveryProviderError(error)) {
    return createError(
      discoveryProviderErrorStatus(error.category),
      `discovery_${error.category}`,
      error.message,
      requestId,
    );
  }

  console.error(`[discovery] unhandled route error; requestId=${requestId}`, {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  });
  return createError(
    500,
    "internal_error",
    "The request could not be completed.",
    requestId,
  );
}
