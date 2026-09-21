import { and, eq, lt } from "drizzle-orm";

import {
  SCAN_CONFIRMED_EVENT,
  SCAN_CONFIRMED_EVENT_CONTRACT,
  CONFIRMATION_COMPLETED_EVENT_CONTRACT,
  type ScanConfirmationSummary,
} from "@vinylhound/contracts";

import type { Database } from "./database.ts";
import {
  applyConfirmationCompletion,
  confirmationEventId,
  getScanConfirmationForUser,
} from "./confirmation-repository.ts";
import { processScanConfirmation } from "./confirmation-processing-repository.ts";
import { DatabaseCommandError } from "./scan-repository.ts";
import {
  confirmationReceipts,
  outboxMessages,
  scanConfirmations,
} from "./schema.ts";

/**
 * P4.2 Task 4 (ADR-0028 amendment): safely re-drives a `pending` confirmation
 * that never reached `completed` -- a BullMQ job that exhausted its attempts,
 * an SQS message that dead-lettered, or simply a slow deploy window. Rather
 * than reaching into the queue (BullMQ won't re-run a job by re-adding its
 * existing `jobId`; SQS has no per-message redrive), this calls the
 * pipeline's own idempotent hop functions directly, off durably stored data
 * -- the `scan.confirmed.v1` outbox row `confirmScan` already wrote, and
 * `confirmation_receipts`' own stored completion payload. Safe to call any
 * number of times, from a user's manual retry or the background sweep below:
 * both hops it drives are idempotent, and `processScanConfirmation` now
 * takes the same advisory lock `confirmScan` does so two concurrent callers
 * for the same event never race on the receipt insert.
 */
export async function reconcileScanConfirmation(
  db: Database,
  input: { userId: string; scanId: string },
): Promise<ScanConfirmationSummary> {
  const confirmation = await db.query.scanConfirmations.findFirst({
    where: and(
      eq(scanConfirmations.scanId, input.scanId),
      eq(scanConfirmations.userId, input.userId),
    ),
  });
  if (!confirmation) {
    throw new DatabaseCommandError("not_found", "Scan confirmation not found.");
  }

  if (confirmation.status === "pending") {
    const receiptKey = confirmationEventId(
      input.scanId,
      confirmation.idempotencyKey,
    );

    const receipt = await db.query.confirmationReceipts.findFirst({
      where: eq(confirmationReceipts.idempotencyKey, receiptKey),
    });
    if (!receipt) {
      const [outboxRow] = await db
        .select()
        .from(outboxMessages)
        .where(
          and(
            eq(outboxMessages.topic, SCAN_CONFIRMED_EVENT),
            eq(outboxMessages.idempotencyKey, receiptKey),
          ),
        )
        .limit(1);
      if (!outboxRow) {
        throw new DatabaseCommandError(
          "invalid_state",
          "This confirmation has no recorded confirmed-scan event to replay.",
        );
      }
      const event = SCAN_CONFIRMED_EVENT_CONTRACT.consumerSchema.parse(
        outboxRow.payload,
      );
      await processScanConfirmation(db, event);
    }

    const refreshed = await db.query.scanConfirmations.findFirst({
      where: eq(scanConfirmations.scanId, input.scanId),
    });
    if (refreshed?.status === "pending") {
      const [nowReceipt] = await db
        .select()
        .from(confirmationReceipts)
        .where(eq(confirmationReceipts.idempotencyKey, receiptKey))
        .limit(1);
      if (nowReceipt) {
        const completion =
          CONFIRMATION_COMPLETED_EVENT_CONTRACT.consumerSchema.parse(
            nowReceipt.payload,
          );
        await applyConfirmationCompletion(db, completion);
      }
    }
  }

  // A null result here means the confirmation's saved record was removed
  // (ADR-0018) -- possibly by an unrelated request racing this one -- which
  // `getScanConfirmationForUser` (also used by the polled `GET /scans/:id`
  // the UI reads) reports as "no confirmation" rather than as this
  // function's own row-existence check above; report it the same way.
  const result = await getScanConfirmationForUser(db, input);
  if (!result) {
    throw new DatabaseCommandError("not_found", "Scan confirmation not found.");
  }
  return result;
}

/**
 * Candidates for the background reconciliation sweep
 * (`apps/worker/src/index.ts`) -- confirmations that have sat `pending`
 * longer than a UX-driven staleness threshold (not a formal SLA; Task 5
 * owns setting one). Same shape as `scan-repository.ts`'s
 * `cleanupAbandonedScans` candidate query. No row locking here: each
 * candidate's actual work (`reconcileScanConfirmation`) is idempotent, so a
 * second sweep instance picking up the same row is wasted work, not a
 * correctness risk.
 */
export async function listStalePendingConfirmations(
  db: Database,
  input: { olderThan: Date; limit: number },
): Promise<Array<{ scanId: string; userId: string }>> {
  const rows = await db
    .select({
      scanId: scanConfirmations.scanId,
      userId: scanConfirmations.userId,
    })
    .from(scanConfirmations)
    .where(
      and(
        eq(scanConfirmations.status, "pending"),
        lt(scanConfirmations.confirmedAt, input.olderThan),
      ),
    )
    .orderBy(scanConfirmations.confirmedAt)
    .limit(input.limit);
  return rows;
}
