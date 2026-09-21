import type { ConfirmationCompletedEvent } from "@vinylhound/contracts";
import {
  applyConfirmationCompletion,
  type Database,
} from "@vinylhound/database";

export interface ConfirmationCompletionDelivery {
  jobId: string;
  deliveryAttempt: number;
  maxAttempts: number;
}

export interface ConfirmationCompletionHandlerOptions {
  database: Database;
}

/**
 * The "scan" hop of P4.2 Task 3's pipeline (ADR-0028): consumes a delivered
 * `confirmation.completed.v1` event and projects it onto `scan_confirmations`
 * via `applyConfirmationCompletion` -- "scan consumes completion into a
 * projection." Both roles (`processScanConfirmation` above, this) run in the
 * same physical `apps/worker` process today; the boundary Task 3 draws is
 * which tables each transaction touches, not process isolation, which is
 * Task 7's job (ADR-0027).
 */
export function createConfirmationCompletionHandler(
  options: ConfirmationCompletionHandlerOptions,
) {
  return async (
    payload: ConfirmationCompletedEvent,
    delivery: ConfirmationCompletionDelivery,
  ) => {
    const result = await applyConfirmationCompletion(options.database, payload);
    console.info(
      JSON.stringify({
        event: "confirmation_completion_applied",
        scanId: payload.scanId,
        idempotencyKey: payload.idempotencyKey,
        deliveryAttempt: delivery.deliveryAttempt,
        // P4.2 Task 5 (ADR-0028): the confirmation-to-library latency this
        // task's target bounds -- null on the redelivery/missing-row no-op
        // paths `applyConfirmationCompletion` already documents.
        confirmationToLibraryLatencyMs: result?.latencyMs ?? null,
      }),
    );
  };
}
