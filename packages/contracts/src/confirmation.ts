import { z } from "zod";

import { CorrelationIdSchema } from "./common.ts";
import { defineEventContract } from "./versioning.ts";
import { ReviewedReleaseShape } from "./library.ts";

/**
 * P4.2 Task 3 (ADR-0028, superseding ADR-0005): `confirmScan`'s transaction
 * no longer resolves a release or writes a library row itself. It stores the
 * reviewed confirmation and enqueues this event; a "core" consumer
 * (`processScanConfirmation`) picks it up, resolves the release, writes
 * `library_items`/`library_copies`, and emits `CONFIRMATION_COMPLETED_EVENT`
 * in reply. Reuses `library.ts`'s `ReviewedReleaseShape` so the event carries
 * exactly what the user submitted, the same shape `ConfirmScanRequestSchema`
 * validates at the HTTP boundary.
 */
export const ScanConfirmedEventSchema = z
  .object({
    eventVersion: z.literal(1),
    scanId: z.string().uuid(),
    userId: z.string().uuid(),
    selectedCandidateId: z.string().uuid().nullable(),
    ...ReviewedReleaseShape,
    idempotencyKey: z.string().min(1).max(255),
    confirmedAt: z.string().datetime(),
    correlationId: CorrelationIdSchema.optional(),
  })
  .strict();

export const SCAN_CONFIRMED_EVENT = "scan.confirmed.v1" as const;

export const SCAN_CONFIRMED_EVENT_CONTRACT = defineEventContract({
  topic: SCAN_CONFIRMED_EVENT,
  versionField: "eventVersion",
  schema: ScanConfirmedEventSchema,
});

/**
 * Reply to `ScanConfirmedEventSchema`, emitted by `processScanConfirmation`'s
 * transaction (the same one that inserts the `confirmation_receipts` row
 * this event is read from) and projected onto `scan_confirmations` by
 * `applyConfirmationCompletion`. `copyId` is null exactly when the
 * confirmation's `list` was `"wishlist"`.
 */
export const ConfirmationCompletedEventSchema = z
  .object({
    eventVersion: z.literal(1),
    scanId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(255),
    releaseId: z.string().uuid(),
    libraryItemId: z.string().uuid(),
    copyId: z.string().uuid().nullable(),
    completedAt: z.string().datetime(),
  })
  .strict();

export const CONFIRMATION_COMPLETED_EVENT =
  "confirmation.completed.v1" as const;

export const CONFIRMATION_COMPLETED_EVENT_CONTRACT = defineEventContract({
  topic: CONFIRMATION_COMPLETED_EVENT,
  versionField: "eventVersion",
  schema: ConfirmationCompletedEventSchema,
});

export type ScanConfirmedEvent = z.infer<typeof ScanConfirmedEventSchema>;
export type ConfirmationCompletedEvent = z.infer<
  typeof ConfirmationCompletedEventSchema
>;
