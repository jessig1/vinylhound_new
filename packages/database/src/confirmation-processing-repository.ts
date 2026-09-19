import { eq, sql } from "drizzle-orm";

import {
  CONFIRMATION_COMPLETED_EVENT,
  type ScanConfirmedEvent,
} from "@vinylhound/contracts";

import type { Database } from "./database.ts";
import { confirmationEventId } from "./confirmation-repository.ts";
import { resolveReviewedRelease } from "./release-resolution.ts";
import { confirmationReceipts, libraryCopies, libraryItems } from "./schema.ts";

/**
 * The "core" side of P4.2 Task 3's async confirmation pipeline (ADR-0028):
 * consumes a delivered `scan.confirmed.v1` event and, in one transaction,
 * atomically (a) checks `confirmation_receipts` for this event's
 * `idempotencyKey` -- the inbox dedupe guard against redelivery -- (b) on a
 * first delivery, resolves the reviewed release and writes
 * `library_items`/`library_copies` (moved here from the old, synchronous
 * `confirmScan`), and (c) records the `confirmation_receipts` row, which
 * doubles as the durable `confirmation.completed.v1` event
 * `dispatchNextConfirmationReceipt` will later deliver back to `scan`.
 *
 * A redelivery of the same event (the same `idempotencyKey`) after the
 * receipt already exists does nothing: the catalog/library write already
 * happened exactly once, and the existing receipt row is what gets
 * (re-)dispatched, never a second one.
 */
export async function processScanConfirmation(
  db: Database,
  payload: ScanConfirmedEvent,
): Promise<void> {
  const receiptKey = confirmationEventId(
    payload.scanId,
    payload.idempotencyKey,
  );

  await db.transaction(async (transaction) => {
    const existing = await transaction.query.confirmationReceipts.findFirst({
      where: eq(confirmationReceipts.idempotencyKey, receiptKey),
    });
    if (existing) {
      return;
    }

    const { release } = await resolveReviewedRelease(transaction, {
      artist: payload.artist,
      title: payload.title,
      releaseYear: payload.releaseYear,
      label: payload.label,
      catalogNumber: payload.catalogNumber,
      barcode: payload.barcode,
      releaseDate: payload.releaseDate,
      country: payload.country,
      format: payload.format,
      packaging: payload.packaging,
      releaseStatus: payload.releaseStatus,
      catalogReference: payload.catalogReference,
    });

    const now = new Date();
    const [libraryItem] = await transaction
      .insert(libraryItems)
      .values({
        userId: payload.userId,
        releaseId: release.id,
        list: payload.list,
        notes: payload.notes,
        confirmedFromScanId: payload.scanId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [libraryItems.userId, libraryItems.releaseId],
        set: {
          list: sql`case
            when ${libraryItems.list} = 'collection'::library_list
              or excluded.list = 'collection'::library_list
            then 'collection'::library_list
            else 'wishlist'::library_list
          end`,
          notes: payload.notes,
          confirmedFromScanId: payload.scanId,
          updatedAt: now,
        },
      })
      .returning();

    const [copy] =
      payload.list === "collection"
        ? await transaction
            .insert(libraryCopies)
            .values({
              userId: payload.userId,
              libraryItemId: libraryItem!.id,
              releaseId: release.id,
              confirmedFromScanId: payload.scanId,
              mediaCondition: payload.copy?.mediaCondition ?? null,
              sleeveCondition: payload.copy?.sleeveCondition ?? null,
              location: payload.copy?.location ?? null,
              notes: payload.copy?.notes ?? null,
              acquiredAt: payload.copy?.acquiredAt ?? null,
              updatedAt: now,
            })
            .returning()
        : [undefined];

    await transaction.insert(confirmationReceipts).values({
      scanId: payload.scanId,
      userId: payload.userId,
      idempotencyKey: receiptKey,
      topic: CONFIRMATION_COMPLETED_EVENT,
      releaseId: release.id,
      libraryItemId: libraryItem!.id,
      copyId: copy?.id ?? null,
      payload: {
        eventVersion: 1,
        scanId: payload.scanId,
        idempotencyKey: payload.idempotencyKey,
        releaseId: release.id,
        libraryItemId: libraryItem!.id,
        copyId: copy?.id ?? null,
        completedAt: now.toISOString(),
      },
      completedAt: now,
    });
  });
}
