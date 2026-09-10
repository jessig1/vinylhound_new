import { z } from "zod";

/**
 * A caller-supplied trace identifier accepted from the inbound `x-request-id`
 * header and forwarded onto the outbox row, the job payload, and the worker
 * attempt it produces, purely so the same value can be grepped across all
 * three. It is untrusted metadata, never identity: it is never used for
 * lookups, joins, or authorization, and an invalid or missing value is
 * dropped rather than rejected.
 */
export const CORRELATION_ID_MAX_LENGTH = 200;

export const CorrelationIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(CORRELATION_ID_MAX_LENGTH)
  .regex(
    /^[A-Za-z0-9._-]+$/,
    "correlationId may only contain letters, digits, '.', '_', or '-'.",
  );

export type CorrelationId = z.infer<typeof CorrelationIdSchema>;

export const CORRELATION_ID_HEADER = "x-request-id";
