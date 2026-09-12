import { and, eq, sql } from "drizzle-orm";

import type {
  PlaceLibraryRelease,
  PlaceLibraryReleaseResponse,
} from "@vinylhound/contracts";

import type { Database } from "./database.ts";
import { resolveReviewedRelease, serializeCopy } from "./release-resolution.ts";
import { DatabaseCommandError } from "./scan-repository.ts";
import { libraryCopies, libraryItems } from "./schema.ts";

/**
 * Saves a release into a user's library without a scan, for the `/discover`
 * flow (ADR-0019, roadmap P3.3 Task 3).
 *
 * Two differences from {@link confirmScan} matter:
 *
 * 1. **No invented image history.** `confirmedFromScanId` stays null and no
 *    `scan_confirmations` row is written, because no scan was reviewed. The
 *    saved record is honest about having come from a catalog lookup.
 * 2. **Idempotent by identity, not by key.** A repeat call converges on the
 *    same state instead of stacking duplicates, so no `Idempotency-Key` is
 *    required — the same reasoning as `DELETE /library/{itemId}`. The library
 *    item is upserted on `(user_id, release_id)`, and a `collection`
 *    placement adds a copy only when the item has none yet, matching the
 *    existing "first owned copy" rule. A user who genuinely owns two pressings
 *    adds the second through per-copy editing, where that intent is explicit.
 */
export async function placeLibraryRelease(
  db: Database,
  input: {
    userId: string;
    placement: PlaceLibraryRelease;
  },
): Promise<{ record: PlaceLibraryReleaseResponse; created: boolean }> {
  const { placement } = input;

  return db.transaction(async (transaction) => {
    const { release } = await resolveReviewedRelease(transaction, {
      artist: placement.artist,
      title: placement.title,
      releaseYear: placement.releaseYear,
      label: placement.label,
      catalogNumber: placement.catalogNumber,
      barcode: placement.barcode,
      releaseDate: placement.releaseDate,
      country: placement.country,
      format: placement.format,
      packaging: placement.packaging,
      releaseStatus: placement.releaseStatus,
      catalogReference: placement.catalogReference,
    });

    const existingItem = await transaction.query.libraryItems.findFirst({
      where: and(
        eq(libraryItems.userId, input.userId),
        eq(libraryItems.releaseId, release.id),
      ),
    });

    const now = new Date();
    const [libraryItem] = await transaction
      .insert(libraryItems)
      .values({
        userId: input.userId,
        releaseId: release.id,
        list: placement.list,
        notes: placement.notes,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [libraryItems.userId, libraryItems.releaseId],
        set: {
          // Owning a record outranks wanting it: adding to the collection
          // promotes an existing wishlist entry, and a later wishlist request
          // never demotes something already owned.
          list: sql`case
            when ${libraryItems.list} = 'collection'::library_list
              or excluded.list = 'collection'::library_list
            then 'collection'::library_list
            else 'wishlist'::library_list
          end`,
          notes: placement.notes,
          updatedAt: now,
        },
      })
      .returning();
    if (!libraryItem) {
      throw new DatabaseCommandError(
        "conflict",
        "The library item could not be saved.",
      );
    }

    const [existingCopy] = await transaction
      .select({ id: libraryCopies.id })
      .from(libraryCopies)
      .where(eq(libraryCopies.libraryItemId, libraryItem.id))
      .limit(1);

    const [copy] =
      libraryItem.list === "collection" && !existingCopy
        ? await transaction
            .insert(libraryCopies)
            .values({
              userId: input.userId,
              libraryItemId: libraryItem.id,
              releaseId: release.id,
              mediaCondition: placement.copy?.mediaCondition ?? null,
              sleeveCondition: placement.copy?.sleeveCondition ?? null,
              location: placement.copy?.location ?? null,
              notes: placement.copy?.notes ?? null,
              acquiredAt: placement.copy?.acquiredAt ?? null,
              updatedAt: now,
            })
            .returning()
        : [undefined];

    const savedCopy =
      copy ??
      (existingCopy
        ? await transaction.query.libraryCopies.findFirst({
            where: eq(libraryCopies.id, existingCopy.id),
          })
        : undefined);

    return {
      created: !existingItem,
      record: {
        release: {
          id: release.id,
          artist: placement.artist,
          title: placement.title,
          releaseYear: placement.releaseYear,
          label: placement.label,
          catalogNumber: placement.catalogNumber,
          barcode: placement.barcode,
          releaseDate: placement.releaseDate,
          country: placement.country,
          format: placement.format,
          packaging: placement.packaging,
          releaseStatus: placement.releaseStatus,
          catalogReference: placement.catalogReference,
        },
        libraryItem: {
          id: libraryItem.id,
          list: libraryItem.list,
          notes: libraryItem.notes,
          copy: savedCopy ? serializeCopy(savedCopy) : null,
        },
        placedAt: now.toISOString(),
      },
    };
  });
}
