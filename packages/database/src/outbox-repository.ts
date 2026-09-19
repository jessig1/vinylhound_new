import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";

import { ANALYZE_SCAN_JOB, getEventContract } from "@vinylhound/contracts";

import type { Database } from "./database.ts";
import { outboxMessages, scans } from "./schema.ts";

export type OutboxDispatchResult =
  | { status: "idle" }
  | { status: "published"; messageId: string; jobId: string }
  | { status: "deferred"; messageId: string; jobId: string }
  | { status: "canceled"; messageId: string; jobId: string };

/**
 * Delivers one outbox row's payload for its topic. The dispatcher parses the
 * stored payload through the topic's registered `consumerSchema` (tolerant
 * of fields a newer producer may have added, ADR-0022) before calling this,
 * so a publisher only ever sees a value shaped like its own contract; a
 * topic with no registered contract is passed its raw stored payload.
 */
export type OutboxPublisher = (
  payload: unknown,
  idempotencyKey: string,
) => Promise<void>;

/** One publisher per topic this process can deliver. */
export type OutboxPublisherRegistry = Record<string, OutboxPublisher>;

/**
 * Claims and delivers the single oldest available outbox row across every
 * topic, generalized from the scan-analysis-only design
 * `docs/PHASE_3_4_PLAN_REVIEW.md`'s G8 flagged (P4.2 Task 2, amending
 * ADR-0004). `SELECT ... FOR UPDATE SKIP LOCKED` still lets multiple
 * publisher processes claim distinct rows concurrently, and exponential
 * backoff plus the row lock held across the publish call are unchanged from
 * the scan-only implementation this replaces.
 *
 * Cancellation is scoped to `scan.analyze.v1` deliberately: it is the only
 * topic whose aggregate (a scan) can be canceled by the user between submit
 * and dispatch. Other topics have no equivalent skip signal, so they are
 * never looked up against `scans`.
 */
export async function dispatchNextOutboxMessage(
  db: Database,
  publishers: OutboxPublisherRegistry,
  now = new Date(),
): Promise<OutboxDispatchResult> {
  return db.transaction(async (transaction) => {
    const [message] = await transaction
      .select()
      .from(outboxMessages)
      .where(
        and(
          isNull(outboxMessages.publishedAt),
          lte(outboxMessages.availableAt, now),
        ),
      )
      .orderBy(asc(outboxMessages.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });

    if (!message) {
      return { status: "idle" };
    }

    if (message.topic === ANALYZE_SCAN_JOB) {
      const [owningScan] = await transaction
        .select({ status: scans.status })
        .from(scans)
        .where(eq(scans.id, message.aggregateId));
      if (owningScan?.status === "canceled") {
        await transaction
          .update(outboxMessages)
          .set({
            publishAttempts: sql`${outboxMessages.publishAttempts} + 1`,
            publishedAt: now,
            lastError: "Skipped: the owning scan was canceled.",
          })
          .where(eq(outboxMessages.id, message.id));
        return {
          status: "canceled",
          messageId: message.id,
          jobId: message.idempotencyKey,
        };
      }
    }

    const nextAttempt = message.publishAttempts + 1;
    try {
      const publish = publishers[message.topic];
      if (!publish) {
        throw new Error(
          `No outbox publisher is registered for topic "${message.topic}".`,
        );
      }
      // A stored payload may come from a newer web deployment; read it
      // tolerantly so an unknown advisory field cannot poison the row. A
      // topic with no registered contract is forwarded as stored.
      const contract = getEventContract(message.topic);
      const payload = contract
        ? contract.consumerSchema.parse(message.payload)
        : message.payload;
      await publish(payload, message.idempotencyKey);
    } catch {
      const delayMs = Math.min(2 ** Math.min(nextAttempt, 6) * 1_000, 60_000);
      await transaction
        .update(outboxMessages)
        .set({
          publishAttempts: sql`${outboxMessages.publishAttempts} + 1`,
          availableAt: new Date(now.getTime() + delayMs),
          lastError: "Queue publication failed.",
        })
        .where(eq(outboxMessages.id, message.id));
      return {
        status: "deferred",
        messageId: message.id,
        jobId: message.idempotencyKey,
      };
    }

    await transaction
      .update(outboxMessages)
      .set({
        publishAttempts: sql`${outboxMessages.publishAttempts} + 1`,
        publishedAt: now,
        lastError: null,
      })
      .where(eq(outboxMessages.id, message.id));

    return {
      status: "published",
      messageId: message.id,
      jobId: message.idempotencyKey,
    };
  });
}
