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

/**
 * Bounded retry for a single remote call (P4.1 Task 5): ADR-0026 pins
 * `apps/discovery` to exactly one replica with a stop-then-start rollout, so
 * a request can legitimately race a deploy or pod-eviction restart and see a
 * connection failure or a transient `rate_limit`/`provider_unavailable`
 * response with nothing wrong at the calling end. Three attempts with a
 * short, linearly increasing delay (100ms, 200ms) rides out that kind of gap
 * without turning a real, sustained outage into a long hang — the ADR
 * explicitly accepts that a prolonged outage still surfaces to the caller,
 * it does not promise retries mask it. Only errors `isRetryable` marks
 * transient are retried; a `not_found`/`invalid_response`/`not_configured`
 * failure (or any error that is not one of this package's own provider
 * errors) is never retried, since retrying it cannot change the outcome.
 */
export async function callWithRetry<T>(
  attempt: () => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 100;
  for (let attemptNumber = 1; ; attemptNumber++) {
    try {
      return await attempt();
    } catch (error) {
      if (attemptNumber >= attempts || !isRetryable(error)) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, delayMs * attemptNumber),
      );
    }
  }
}
