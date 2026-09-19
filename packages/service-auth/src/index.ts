import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

/**
 * Proves two things about one internal HTTP call in a single signed token:
 * the caller holds the shared secret (service identity — only `apps/web`
 * knows it, not an arbitrary caller on the same network), and the specific
 * user the caller is acting for (user authorization), bound together so
 * neither can be forged independently. This is deliberately not a bare
 * `X-User-Id` header: anyone who can reach the discovery service over the
 * network could set that to any value, whereas a signature only the secret
 * holder can produce cannot. What this does NOT provide is network-layer
 * service identity (mTLS, IAM SigV4, private-subnet-only ingress) — that is
 * infrastructure, decided in P4.1 Task 5, not here.
 */
export interface ServiceAuthClaims {
  userId: string;
}

const ServiceAuthPayloadSchema = z.object({
  sub: z.string().min(1),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
});

export type ServiceAuthErrorReason =
  "missing" | "malformed" | "expired" | "invalid_signature";

export class ServiceAuthError extends Error {
  constructor(
    readonly reason: ServiceAuthErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "ServiceAuthError";
  }
}

const DEFAULT_TTL_SECONDS = 30;

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(secret: string, encodedPayload: string): string {
  return createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
}

/**
 * Mints a short-lived token asserting `claims.userId` acted through this
 * call. Minted fresh per outgoing request (never cached or reused across
 * calls), so the default 30-second TTL only needs to cover one network round
 * trip, not a session.
 */
export function signServiceRequest(
  secret: string,
  claims: ServiceAuthClaims,
  options: { now?: () => number; ttlSeconds?: number } = {},
): string {
  const now = options.now ?? Date.now;
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const nowSeconds = Math.floor(now() / 1000);
  const encodedPayload = base64UrlEncode(
    JSON.stringify({
      sub: claims.userId,
      iat: nowSeconds,
      exp: nowSeconds + ttlSeconds,
    }),
  );
  return `${encodedPayload}.${sign(secret, encodedPayload)}`;
}

/**
 * Verifies a token minted by {@link signServiceRequest} against the same
 * shared secret. Throws {@link ServiceAuthError} rather than returning null
 * so a caller cannot forget to check a falsy result — every failure mode
 * (missing, malformed, expired, wrong signature) must be handled explicitly
 * at the HTTP boundary.
 */
export function verifyServiceRequest(
  secret: string,
  token: string | null | undefined,
  options: { now?: () => number } = {},
): ServiceAuthClaims {
  if (!token) {
    throw new ServiceAuthError(
      "missing",
      "No service authorization token was supplied.",
    );
  }
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ServiceAuthError(
      "malformed",
      "The service authorization token is malformed.",
    );
  }
  const [encodedPayload, signature] = parts;
  const expectedSignature = sign(secret, encodedPayload);
  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  // timingSafeEqual throws on mismatched lengths rather than returning
  // false, so the length check must happen first — and must not itself leak
  // timing, which is why it is a plain comparison against the fixed-length
  // HMAC output rather than an early return keyed on attacker input length.
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    throw new ServiceAuthError(
      "invalid_signature",
      "The service authorization token's signature is invalid.",
    );
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    throw new ServiceAuthError(
      "malformed",
      "The service authorization token payload could not be parsed.",
    );
  }
  const parsedPayload = ServiceAuthPayloadSchema.safeParse(rawPayload);
  if (!parsedPayload.success) {
    throw new ServiceAuthError(
      "malformed",
      "The service authorization token payload did not match the expected shape.",
    );
  }

  const now = options.now ?? Date.now;
  if (parsedPayload.data.exp < Math.floor(now() / 1000)) {
    throw new ServiceAuthError(
      "expired",
      "The service authorization token has expired.",
    );
  }
  return { userId: parsedPayload.data.sub };
}

export const SERVICE_AUTH_HEADER = "authorization";

export function formatServiceAuthHeader(token: string): string {
  return `Bearer ${token}`;
}

export function parseServiceAuthHeader(
  headerValue: string | null | undefined,
): string | null {
  if (!headerValue) return null;
  const match = /^Bearer (.+)$/.exec(headerValue);
  return match ? match[1] : null;
}
