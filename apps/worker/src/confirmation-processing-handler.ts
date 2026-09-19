import type { ScanConfirmedEvent } from "@vinylhound/contracts";
import { processScanConfirmation, type Database } from "@vinylhound/database";

export interface ConfirmationProcessingDelivery {
  jobId: string;
  deliveryAttempt: number;
  maxAttempts: number;
}

export interface ConfirmationProcessingHandlerOptions {
  database: Database;
}

/**
 * The "core" hop of P4.2 Task 3's pipeline (ADR-0028): consumes a delivered
 * `scan.confirmed.v1` event and hands it to `processScanConfirmation`, whose
 * own transaction is the atomic inbox-dedupe + catalog/library write +
 * completion-event record. This handler adds only delivery logging on top --
 * a queue redelivery after a transient failure is handled by
 * `processScanConfirmation`'s own idempotency-key check, not by anything
 * here.
 */
export function createConfirmationProcessingHandler(
  options: ConfirmationProcessingHandlerOptions,
) {
  return async (
    payload: ScanConfirmedEvent,
    delivery: ConfirmationProcessingDelivery,
  ) => {
    await processScanConfirmation(options.database, payload);
    console.info(
      JSON.stringify({
        event: "scan_confirmation_processed",
        scanId: payload.scanId,
        idempotencyKey: payload.idempotencyKey,
        correlationId: payload.correlationId,
        deliveryAttempt: delivery.deliveryAttempt,
      }),
    );
  };
}
