import { ApiErrorSchema } from "@vinylhound/contracts";

/**
 * Shared by both remote clients: reads the `{ error: { code, message } }`
 * body `apps/discovery` sends on a non-2xx response — the same
 * `ApiErrorSchema` shape `apps/web`'s own `createError` already produces, so
 * the two error-mapping conventions never drift apart. Returns null on any
 * parse failure rather than throwing, so a malformed or non-JSON error body
 * degrades to the caller's own generic fallback instead of masking the
 * original HTTP status with a JSON-parsing error.
 */
export async function readWireError(
  response: Response,
): Promise<{ code: string; message: string } | null> {
  try {
    const body: unknown = await response.json();
    const parsed = ApiErrorSchema.safeParse(body);
    return parsed.success ? parsed.data.error : null;
  } catch {
    return null;
  }
}

/**
 * A category recovered from a `<prefix><category>` wire error code is
 * retried by the same fixed convention every in-process adapter already
 * uses (`rate_limit`/`provider_unavailable` are transient; `not_found`/
 * `invalid_response`/`not_configured` are not) — the wire error carries no
 * separate retryable flag, so this is the one place that decides it for
 * every category a remote client can see.
 */
export function isRetryableCategory(category: string): boolean {
  return category === "rate_limit" || category === "provider_unavailable";
}
