import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";

import { CONFIRMATION_COMPLETED_EVENT_CONTRACT } from "@vinylhound/contracts";

import type { CoreDatabase } from "./database.ts";
import { confirmationReceipts } from "./schema.ts";

export type ConfirmationReceiptDispatchResult =
  | { status: "idle" }
  | { status: "published"; receiptId: string; idempotencyKey: string }
  | { status: "deferred"; receiptId: string; idempotencyKey: string };

export type ConfirmationReceiptPublisher = (
  payload: unknown,
  idempotencyKey: string,
) => Promise<void>;

/**
 * The second dispatcher of P4.2 Task 3's pipeline (ADR-0028): claims and
 * delivers the oldest undelivered `confirmation_receipts` row -- the
 * completion event hop 3 (`applyConfirmationCompletion`) is waiting on.
 * Deliberately not shared with `dispatchNextOutboxMessage`
 * (`outbox-repository.ts`): that function is multi-topic, looks up a
 * publisher from a topic-keyed registry, and scopes a cancellation check to
 * `scan.analyze.v1` specifically. None of that applies to this table -- it
 * has exactly one topic, one caller-supplied publisher, and no cancellation
 * concept -- so a second, simpler function reads more clearly than a shared
 * generic over two differently-shaped Drizzle tables.
 */
export async function dispatchNextConfirmationReceipt(
  db: CoreDatabase,
  publish: ConfirmationReceiptPublisher,
  now = new Date(),
): Promise<ConfirmationReceiptDispatchResult> {
  return db.transaction(async (transaction) => {
    const [receipt] = await transaction
      .select()
      .from(confirmationReceipts)
      .where(
        and(
          isNull(confirmationReceipts.publishedAt),
          lte(confirmationReceipts.availableAt, now),
        ),
      )
      .orderBy(asc(confirmationReceipts.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });

    if (!receipt) {
      return { status: "idle" };
    }

    const nextAttempt = receipt.publishAttempts + 1;
    try {
      // Tolerant parse (ADR-0022): a receipt written by a newer deployment
      // may carry an optional field this version does not know.
      const payload =
        CONFIRMATION_COMPLETED_EVENT_CONTRACT.consumerSchema.parse(
          receipt.payload,
        );
      await publish(payload, receipt.idempotencyKey);
    } catch {
      const delayMs = Math.min(2 ** Math.min(nextAttempt, 6) * 1_000, 60_000);
      await transaction
        .update(confirmationReceipts)
        .set({
          publishAttempts: sql`${confirmationReceipts.publishAttempts} + 1`,
          availableAt: new Date(now.getTime() + delayMs),
          lastError: "Queue publication failed.",
        })
        .where(eq(confirmationReceipts.id, receipt.id));
      return {
        status: "deferred",
        receiptId: receipt.id,
        idempotencyKey: receipt.idempotencyKey,
      };
    }

    await transaction
      .update(confirmationReceipts)
      .set({
        publishAttempts: sql`${confirmationReceipts.publishAttempts} + 1`,
        publishedAt: now,
        lastError: null,
      })
      .where(eq(confirmationReceipts.id, receipt.id));

    return {
      status: "published",
      receiptId: receipt.id,
      idempotencyKey: receipt.idempotencyKey,
    };
  });
}
