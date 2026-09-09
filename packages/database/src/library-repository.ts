import { and, asc, count, desc, eq, inArray, isNotNull } from "drizzle-orm";

import type {
  GetLibraryResponse,
  LibraryCoverImage,
  LibraryItemResult,
  LibraryCopy,
  LibraryList,
  LibrarySort,
  UpdateLibraryCopy,
  UpdateLibraryItem,
} from "@vinylhound/contracts";

import type { Database } from "./database.js";
import { DatabaseCommandError } from "./scan-repository.js";
import {
  albums,
  imageAssets,
  libraryCopies,
  libraryItems,
  releases,
  scanConfirmations,
} from "./schema.js";

export async function listLibraryItemsForUser(
  db: Database,
  input: {
    userId: string;
    list: LibraryList;
    query?: string;
    sort?: LibrarySort;
  },
): Promise<GetLibraryResponse> {
  const rows = await selectLibraryItemRows(db, {
    userId: input.userId,
    list: input.list,
  });
  const items = sortLibraryItems(
    filterLibraryItemsByQuery(
      await attachCopiesAndSerialize(db, input.userId, rows),
      input.query,
    ),
    input.sort ?? "recent",
  );
  return { list: input.list, items };
}

export async function getLibraryItemForUser(
  db: Database,
  input: { userId: string; itemId: string },
): Promise<LibraryItemResult> {
  const rows = await selectLibraryItemRows(db, {
    userId: input.userId,
    itemId: input.itemId,
  });
  const [item] = await attachCopiesAndSerialize(db, input.userId, rows);
  if (!item) {
    throw new DatabaseCommandError("not_found", "Library item not found.");
  }
  return item;
}

export async function countLibraryItemsForUser(
  db: Database,
  input: { userId: string; list: LibraryList },
): Promise<number> {
  const [result] = await db
    .select({ value: count() })
    .from(libraryItems)
    .where(
      and(
        eq(libraryItems.userId, input.userId),
        eq(libraryItems.list, input.list),
      ),
    );
  return result?.value ?? 0;
}

export function filterLibraryItemsByQuery(
  items: LibraryItemResult[],
  query: string | undefined,
): LibraryItemResult[] {
  if (!query) return items;
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter(
    (item) =>
      item.release.artist.toLowerCase().includes(needle) ||
      item.release.title.toLowerCase().includes(needle),
  );
}

function sortLibraryItems(
  items: LibraryItemResult[],
  sort: LibrarySort,
): LibraryItemResult[] {
  if (sort === "recent") return items;
  const sorted = [...items];
  sorted.sort((a, b) => {
    const key = sort === "artist" ? "artist" : "title";
    return a.release[key].localeCompare(b.release[key], undefined, {
      sensitivity: "base",
    });
  });
  return sorted;
}

export async function updateLibraryItem(
  db: Database,
  input: { userId: string; itemId: string; update: UpdateLibraryItem },
): Promise<LibraryItemResult> {
  return db.transaction(async (transaction) => {
    const [item] = await transaction
      .select()
      .from(libraryItems)
      .where(
        and(
          eq(libraryItems.id, input.itemId),
          eq(libraryItems.userId, input.userId),
        ),
      )
      .for("update");
    if (!item) {
      throw new DatabaseCommandError("not_found", "Library item not found.");
    }

    const nextList = input.update.list ?? item.list;
    if (nextList === "wishlist" && item.list === "collection") {
      const [existingCopy] = await transaction
        .select({ id: libraryCopies.id })
        .from(libraryCopies)
        .where(eq(libraryCopies.libraryItemId, item.id))
        .limit(1);
      if (existingCopy) {
        throw new DatabaseCommandError(
          "invalid_state",
          "Remove this item's physical copies before moving it to the wishlist.",
        );
      }
    }

    const now = new Date();
    await transaction
      .update(libraryItems)
      .set({
        list: nextList,
        notes:
          input.update.notes !== undefined ? input.update.notes : item.notes,
        updatedAt: now,
      })
      .where(eq(libraryItems.id, item.id));

    if (nextList === "collection" && item.list === "wishlist") {
      const [existingCopy] = await transaction
        .select({ id: libraryCopies.id })
        .from(libraryCopies)
        .where(eq(libraryCopies.libraryItemId, item.id))
        .limit(1);
      if (!existingCopy) {
        await transaction.insert(libraryCopies).values({
          userId: input.userId,
          libraryItemId: item.id,
          releaseId: item.releaseId,
          updatedAt: now,
        });
      }
    }

    const rows = await selectLibraryItemRows(transaction, {
      userId: input.userId,
      itemId: item.id,
    });
    const [result] = await attachCopiesAndSerialize(
      transaction,
      input.userId,
      rows,
    );
    if (!result) {
      throw new DatabaseCommandError(
        "invalid_state",
        "The updated library item could not be read back.",
      );
    }
    return result;
  });
}

export async function deleteLibraryItem(
  db: Database,
  input: { userId: string; itemId: string },
): Promise<{ id: string }> {
  return db.transaction(async (transaction) => {
    const [item] = await transaction
      .select({ id: libraryItems.id })
      .from(libraryItems)
      .where(
        and(
          eq(libraryItems.id, input.itemId),
          eq(libraryItems.userId, input.userId),
        ),
      )
      .for("update");
    if (!item) {
      throw new DatabaseCommandError("not_found", "Library item not found.");
    }

    // Confirmations are not deleted with the item: their library_item_id
    // clears itself (ADR-0018) so the record of what was reviewed and when
    // survives, while the scan reads as reviewable again.
    const [deleted] = await transaction
      .delete(libraryItems)
      .where(eq(libraryItems.id, item.id))
      .returning({ id: libraryItems.id });
    if (!deleted) {
      throw new DatabaseCommandError("not_found", "Library item not found.");
    }
    return deleted;
  });
}

export async function updateLibraryCopy(
  db: Database,
  input: {
    userId: string;
    itemId: string;
    copyId: string;
    update: UpdateLibraryCopy;
  },
): Promise<LibraryCopy> {
  return db.transaction(async (transaction) => {
    await lockLibraryItem(transaction, input.userId, input.itemId);
    const [copy] = await transaction
      .select()
      .from(libraryCopies)
      .where(
        and(
          eq(libraryCopies.id, input.copyId),
          eq(libraryCopies.libraryItemId, input.itemId),
          eq(libraryCopies.userId, input.userId),
        ),
      )
      .for("update");
    if (!copy) {
      throw new DatabaseCommandError("not_found", "Library copy not found.");
    }
    const now = new Date();
    const [updated] = await transaction
      .update(libraryCopies)
      .set({ ...input.update, updatedAt: now })
      .where(eq(libraryCopies.id, copy.id))
      .returning();
    await transaction
      .update(libraryItems)
      .set({ updatedAt: now })
      .where(eq(libraryItems.id, input.itemId));
    return serializeLibraryCopy(updated!);
  });
}

export async function deleteLibraryCopy(
  db: Database,
  input: { userId: string; itemId: string; copyId: string },
): Promise<{ id: string }> {
  return db.transaction(async (transaction) => {
    await lockLibraryItem(transaction, input.userId, input.itemId);
    const [deleted] = await transaction
      .delete(libraryCopies)
      .where(
        and(
          eq(libraryCopies.id, input.copyId),
          eq(libraryCopies.libraryItemId, input.itemId),
          eq(libraryCopies.userId, input.userId),
        ),
      )
      .returning({ id: libraryCopies.id });
    if (!deleted) {
      throw new DatabaseCommandError("not_found", "Library copy not found.");
    }
    await transaction
      .update(libraryItems)
      .set({ updatedAt: new Date() })
      .where(eq(libraryItems.id, input.itemId));
    return deleted;
  });
}

async function lockLibraryItem(
  transaction: Parameters<Parameters<Database["transaction"]>[0]>[0],
  userId: string,
  itemId: string,
) {
  const [item] = await transaction
    .select({ id: libraryItems.id })
    .from(libraryItems)
    .where(and(eq(libraryItems.id, itemId), eq(libraryItems.userId, userId)))
    .for("update");
  if (!item) {
    throw new DatabaseCommandError("not_found", "Library item not found.");
  }
  return item;
}

async function selectLibraryItemRows(
  db: Pick<Database, "select">,
  input: { userId: string; list?: LibraryList; itemId?: string },
) {
  return db
    .select({
      id: libraryItems.id,
      list: libraryItems.list,
      notes: libraryItems.notes,
      confirmedFromScanId: libraryItems.confirmedFromScanId,
      createdAt: libraryItems.createdAt,
      updatedAt: libraryItems.updatedAt,
      releaseId: releases.id,
      artist: albums.artist,
      title: albums.title,
      releaseYear: releases.releaseYear,
      label: releases.label,
      catalogNumber: releases.catalogNumber,
      barcode: releases.barcode,
      releaseDate: releases.releaseDate,
      country: releases.country,
      format: releases.format,
      packaging: releases.packaging,
      releaseStatus: releases.releaseStatus,
      reviewedRelease: scanConfirmations.reviewedRelease,
    })
    .from(libraryItems)
    .innerJoin(releases, eq(releases.id, libraryItems.releaseId))
    .innerJoin(albums, eq(albums.id, releases.albumId))
    .leftJoin(
      scanConfirmations,
      eq(scanConfirmations.scanId, libraryItems.confirmedFromScanId),
    )
    .where(
      and(
        eq(libraryItems.userId, input.userId),
        input.list ? eq(libraryItems.list, input.list) : undefined,
        input.itemId ? eq(libraryItems.id, input.itemId) : undefined,
      ),
    )
    .orderBy(desc(libraryItems.updatedAt))
    .limit(100);
}

async function attachCopiesAndSerialize(
  db: Pick<Database, "select">,
  userId: string,
  rows: Awaited<ReturnType<typeof selectLibraryItemRows>>,
): Promise<LibraryItemResult[]> {
  const itemIds = rows.map((row) => row.id);
  const copies = itemIds.length
    ? await db
        .select()
        .from(libraryCopies)
        .where(
          and(
            eq(libraryCopies.userId, userId),
            inArray(libraryCopies.libraryItemId, itemIds),
          ),
        )
        .orderBy(libraryCopies.createdAt)
    : [];
  const copiesByItem = new Map<string, typeof copies>();
  for (const copy of copies) {
    const itemCopies = copiesByItem.get(copy.libraryItemId) ?? [];
    itemCopies.push(copy);
    copiesByItem.set(copy.libraryItemId, itemCopies);
  }
  const coverByScanId = await selectCoverImages(
    db,
    rows.map((row) => row.confirmedFromScanId),
  );

  return rows.map((row) => {
    const reviewed = row.reviewedRelease;
    const catalogReference = reviewed?.catalogReference ?? null;
    const itemCopies = copiesByItem.get(row.id) ?? [];
    return {
      id: row.id,
      list: row.list,
      notes: row.notes,
      release: {
        id: row.releaseId,
        artist: reviewed ? reviewed.artist : row.artist,
        title: reviewed ? reviewed.title : row.title,
        releaseYear: reviewed ? reviewed.releaseYear : row.releaseYear,
        label: reviewed ? reviewed.label : row.label,
        catalogNumber: reviewed ? reviewed.catalogNumber : row.catalogNumber,
        barcode: reviewed ? reviewed.barcode : row.barcode,
        releaseDate: reviewed?.releaseDate ?? row.releaseDate,
        country: reviewed?.country ?? row.country,
        format: reviewed?.format ?? row.format,
        packaging: reviewed?.packaging ?? row.packaging,
        releaseStatus: reviewed?.releaseStatus ?? row.releaseStatus,
        catalogReference,
      },
      copyCount: itemCopies.length,
      copies: itemCopies.map(serializeLibraryCopy),
      confirmedFromScanId: row.confirmedFromScanId,
      coverImage: row.confirmedFromScanId
        ? (coverByScanId.get(row.confirmedFromScanId) ?? null)
        : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

/**
 * The cover a library item displays is the first completed image of the scan it
 * was confirmed from; the item itself owns no image. Read as one batched query
 * so a 100-item page does not issue 100 lookups.
 */
async function selectCoverImages(
  db: Pick<Database, "select">,
  scanIds: readonly (string | null)[],
): Promise<Map<string, LibraryCoverImage>> {
  const ids = [...new Set(scanIds.filter((id): id is string => id !== null))];
  if (!ids.length) return new Map();

  const images = await db
    .select({ id: imageAssets.id, scanId: imageAssets.scanId })
    .from(imageAssets)
    .where(
      and(inArray(imageAssets.scanId, ids), isNotNull(imageAssets.completedAt)),
    )
    .orderBy(asc(imageAssets.createdAt), asc(imageAssets.id));

  const covers = new Map<string, LibraryCoverImage>();
  for (const image of images) {
    if (!covers.has(image.scanId)) {
      covers.set(image.scanId, { scanId: image.scanId, imageId: image.id });
    }
  }
  return covers;
}

function serializeLibraryCopy(
  copy: typeof libraryCopies.$inferSelect,
): LibraryCopy {
  return {
    id: copy.id,
    mediaCondition: copy.mediaCondition,
    sleeveCondition: copy.sleeveCondition,
    location: copy.location,
    notes: copy.notes,
    acquiredAt: copy.acquiredAt,
    createdAt: copy.createdAt.toISOString(),
    updatedAt: copy.updatedAt.toISOString(),
  };
}
