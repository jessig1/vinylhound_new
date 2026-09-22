import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import {
  LIBRARY_PAGE_SIZE_DEFAULT,
  LIBRARY_PAGE_SIZE_MAX,
  MAX_LIBRARY_COPIES_PER_ITEM,
  type CreateLibraryCopy,
  type GetFavoritesResponse,
  type GetLibraryResponse,
  type LibraryCoverImage,
  type LibraryItemResult,
  type LibraryCopy,
  type LibraryList,
  type LibrarySort,
  type UpdateLibraryCopy,
  type UpdateLibraryItem,
} from "@vinylhound/contracts";
import { resolveCopyAddition, resolveFavoritedAt } from "@vinylhound/domain";

import type {
  CoreDatabase,
  CoreTransaction,
  ScanDatabase,
} from "./database.ts";
import { decodeLibraryCursor, encodeLibraryCursor } from "./library-cursor.ts";
import { hashJson } from "./release-resolution.ts";
import { DatabaseCommandError } from "./scan-repository.ts";
import {
  albums,
  imageAssets,
  libraryCopies,
  libraryItems,
  releases,
  scanConfirmations,
} from "./schema.ts";

export interface LibraryPageInput {
  userId: string;
  query?: string;
  sort?: LibrarySort;
  /** A `nextCursor` from the previous page under the same sort. */
  cursor?: string;
  limit?: number;
}

/**
 * One page of a list, searched, sorted and paged in SQL over the whole
 * library rather than within a first fetch of 100 rows (ADR-0023). Search
 * and the name sorts use the same effective artist/title the response
 * shows — a scan confirmation's corrected values over the shared album row
 * (ADR-0012) — so a corrected identification is found and ordered by the
 * name the user confirmed. Pages are keyset continuations: `nextCursor`
 * names the last row's sort key, and the next page starts strictly after
 * it, so an insert or edit between two requests never duplicates or skips a
 * row that was already there.
 */
export async function listLibraryItemsForUser(
  db: Pick<CoreDatabase, "select">,
  scanDb: Pick<ScanDatabase, "select">,
  input: LibraryPageInput & { list: LibraryList },
): Promise<GetLibraryResponse> {
  const page = await selectLibraryItemPage(db, scanDb, {
    ...input,
    recency: "updatedAt",
  });
  return { list: input.list, ...page };
}

/**
 * Favorites across both lists, most recently favorited first. A favorite is
 * an attribute of the saved record rather than a third list (ADR-0021), so
 * this is the same row shape `GET /library` returns, filtered and paged the
 * same way; only `recent` orders by when the record was starred instead of
 * when it last changed.
 */
export async function listFavoriteLibraryItemsForUser(
  db: Pick<CoreDatabase, "select">,
  scanDb: Pick<ScanDatabase, "select">,
  input: LibraryPageInput,
): Promise<GetFavoritesResponse> {
  return selectLibraryItemPage(db, scanDb, {
    ...input,
    favoritesOnly: true,
    recency: "favoritedAt",
  });
}

/**
 * Every record a list read would return, in the same order, one page at a
 * time — what an export walks so it covers all matching records rather than
 * a first page. Callers that only need the first page use
 * `listLibraryItemsForUser` directly.
 */
export async function* iterateLibraryItemsForUser(
  db: Pick<CoreDatabase, "select">,
  scanDb: Pick<ScanDatabase, "select">,
  input: Omit<LibraryPageInput, "cursor" | "limit"> & {
    list: LibraryList;
    pageSize?: number;
  },
): AsyncGenerator<LibraryItemResult[], void, undefined> {
  let cursor: string | undefined;
  do {
    const page = await listLibraryItemsForUser(db, scanDb, {
      ...input,
      cursor,
      limit: input.pageSize ?? LIBRARY_PAGE_SIZE_MAX,
    });
    if (page.items.length) yield page.items;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}

async function selectLibraryItemPage(
  db: Pick<CoreDatabase, "select">,
  scanDb: Pick<ScanDatabase, "select">,
  input: LibraryPageInput & {
    list?: LibraryList;
    favoritesOnly?: boolean;
    recency: "updatedAt" | "favoritedAt";
  },
): Promise<{ items: LibraryItemResult[]; nextCursor: string | null }> {
  const sort = input.sort ?? "recent";
  const limit = Math.min(
    Math.max(input.limit ?? LIBRARY_PAGE_SIZE_DEFAULT, 1),
    LIBRARY_PAGE_SIZE_MAX,
  );
  const ordering = libraryOrdering(sort, input.recency);
  const rows = await selectLibraryItemRows(db, {
    userId: input.userId,
    list: input.list,
    favoritesOnly: input.favoritesOnly,
    query: input.query,
    orderBy: ordering.orderBy,
    after: input.cursor
      ? ordering.after(decodeLibraryCursor(input.cursor, sort))
      : undefined,
    // One row past the page says whether a next page exists without a
    // count query; it is dropped before serialization.
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = await attachCopiesAndSerialize(
    db,
    scanDb,
    input.userId,
    pageRows,
  );
  const last = pageRows[pageRows.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last ? encodeLibraryCursor(sort, ordering.key(last)) : null,
  };
}

/**
 * The user's own saved records by ID, for callers that hold references to
 * them (playlist entries). IDs the user does not own are simply absent from
 * the result rather than an error, so ownership never leaks by difference.
 */
export async function getLibraryItemsByIdForUser(
  db: Pick<CoreDatabase, "select">,
  scanDb: Pick<ScanDatabase, "select">,
  input: { userId: string; itemIds: readonly string[] },
): Promise<Map<string, LibraryItemResult>> {
  if (!input.itemIds.length) return new Map();
  const rows = await selectLibraryItemRows(db, {
    userId: input.userId,
    itemIds: input.itemIds,
    limit: input.itemIds.length,
  });
  const items = await attachCopiesAndSerialize(db, scanDb, input.userId, rows);
  return new Map(items.map((item) => [item.id, item]));
}

export async function getLibraryItemForUser(
  db: CoreDatabase,
  scanDb: ScanDatabase,
  input: { userId: string; itemId: string },
): Promise<LibraryItemResult> {
  const rows = await selectLibraryItemRows(db, {
    userId: input.userId,
    itemId: input.itemId,
    limit: 1,
  });
  const [item] = await attachCopiesAndSerialize(db, scanDb, input.userId, rows);
  if (!item) {
    throw new DatabaseCommandError("not_found", "Library item not found.");
  }
  return item;
}

export async function countLibraryItemsForUser(
  db: CoreDatabase,
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

/**
 * The artist and title a library item displays: the values the user
 * confirmed on the scan it came from when there was one, else the shared
 * album row (ADR-0012). Read from `libraryItems.confirmedRelease` -- a
 * denormalized snapshot written at confirmation time (P4.2 Task 7,
 * ADR-0030) -- rather than a live join into `scan.scan_confirmations`,
 * which is no longer possible in one query once scan and core are separate
 * roles/connections. Search and the name sorts evaluate these in SQL so
 * they see every row; `attachCopiesAndSerialize` resolves the same
 * preference in application code for the fields it returns.
 */
const effectiveArtist = sql<string>`coalesce(${libraryItems.confirmedRelease}->>'artist', ${albums.artist})`;
const effectiveTitle = sql<string>`coalesce(${libraryItems.confirmedRelease}->>'title', ${albums.title})`;
const sortArtist = sql<string>`lower(${effectiveArtist})`;
const sortTitle = sql<string>`lower(${effectiveTitle})`;

/**
 * A timestamp rendered for a cursor at its full microsecond precision, so a
 * continuation compares against exactly the instant the row holds. A JS
 * `Date` keeps milliseconds only and would start the next page a few rows
 * early or late whenever two rows share one.
 */
function cursorTimestamp(
  column: typeof libraryItems.updatedAt | typeof libraryItems.favoritedAt,
) {
  return sql<string>`to_char(${column} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

type LibraryRow = Awaited<ReturnType<typeof selectLibraryItemRows>>[number];

/**
 * How one sort orders rows and continues from a cursor. `orderBy` and
 * `after` name the same expressions in the same order with the id last, so
 * the ordering is total and the keyset comparison is exact: `recent`
 * continues from `(stamp, id)`, a name sort from `(first, second, id)`.
 */
function libraryOrdering(
  sort: LibrarySort,
  recency: "updatedAt" | "favoritedAt",
): {
  orderBy: SQL[];
  key: (row: LibraryRow) => string[];
  after: (key: string[]) => SQL;
} {
  const id = libraryItems.id;
  if (sort === "recent") {
    const favorited = recency === "favoritedAt";
    const stamp = favorited ? libraryItems.favoritedAt : libraryItems.updatedAt;
    return {
      orderBy: [desc(stamp), desc(id)],
      key: (row) => [
        (favorited ? row.favoritedAtCursor : row.updatedAtCursor) ?? "",
        row.id,
      ],
      after: ([stampKey, idKey]) =>
        sql`(${stamp}, ${id}) < (${stampKey}::timestamptz, ${idKey}::uuid)`,
    };
  }
  const [first, second] =
    sort === "artist" ? [sortArtist, sortTitle] : [sortTitle, sortArtist];
  return {
    orderBy: [asc(first), asc(second), asc(id)],
    key: (row) =>
      sort === "artist"
        ? [row.sortArtist, row.sortTitle, row.id]
        : [row.sortTitle, row.sortArtist, row.id],
    after: ([firstKey, secondKey, idKey]) =>
      sql`(${first}, ${second}, ${id}) > (${firstKey}, ${secondKey}, ${idKey}::uuid)`,
  };
}

/**
 * Case-insensitive substring match on the effective artist or title. The
 * query is a bound parameter with LIKE's wildcards escaped, so "100%" finds
 * that text rather than everything.
 */
function searchCondition(query: string | undefined): SQL | undefined {
  const needle = query?.trim();
  if (!needle) return undefined;
  const pattern = `%${needle.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
  return or(ilike(effectiveArtist, pattern), ilike(effectiveTitle, pattern));
}

export async function updateLibraryItem(
  db: CoreDatabase,
  scanDb: ScanDatabase,
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
        favoritedAt:
          input.update.favorite !== undefined
            ? resolveFavoritedAt(item.favoritedAt, input.update.favorite, now)
            : item.favoritedAt,
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
      limit: 1,
    });
    const [result] = await attachCopiesAndSerialize(
      transaction,
      scanDb,
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
  db: CoreDatabase,
  scanDb: ScanDatabase,
  input: { userId: string; itemId: string },
): Promise<{ id: string }> {
  const deleted = await db.transaction(async (transaction) => {
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
    const [row] = await transaction
      .delete(libraryItems)
      .where(eq(libraryItems.id, item.id))
      .returning({ id: libraryItems.id });
    if (!row) {
      throw new DatabaseCommandError("not_found", "Library item not found.");
    }
    return row;
  });

  await bestEffortClearScanConfirmationReference(scanDb, {
    libraryItemId: deleted.id,
  });
  return deleted;
}

/**
 * P4.2 Task 7 (ADR-0030): `scan_confirmations.library_item_id`/`copy_id` are
 * no longer foreign keys (the referenced tables are `core`, a different
 * schema/role), so the `ON DELETE SET NULL` they used to provide is gone.
 * This best-effort write on the `scan` connection replaces it; it is not
 * atomic with the `core` delete above by construction -- a crash between the
 * two leaves this row pointing at an id that no longer exists, which
 * `readConfirmationResponse`/`getScanConfirmationForUser`
 * (`confirmation-repository.ts`) already treat as "removed" on read and
 * lazily self-heal, so a missed or failed call here is safe, not silently
 * wrong.
 */
async function bestEffortClearScanConfirmationReference(
  scanDb: ScanDatabase,
  target: { libraryItemId: string } | { copyId: string },
): Promise<void> {
  try {
    if ("libraryItemId" in target) {
      await scanDb
        .update(scanConfirmations)
        .set({ libraryItemId: null })
        .where(eq(scanConfirmations.libraryItemId, target.libraryItemId));
    } else {
      await scanDb
        .update(scanConfirmations)
        .set({ copyId: null })
        .where(eq(scanConfirmations.copyId, target.copyId));
    }
  } catch {
    // Best-effort: the read-path liveness check is the authoritative
    // fallback (see the doc comment above).
  }
}

/**
 * Records another copy of a record the user owns: a second pressing, or a
 * copy again after the last one was removed (ADR-0024). Rejected on a
 * wishlist record (`invalid_state` — converting it to the collection records
 * the first copy) and at the per-record cap (`library_copy_limit`).
 *
 * Idempotent by key, not identity: two blank copies of one record are
 * legitimately distinct, so a replay is recognized by the `Idempotency-Key`
 * the request carried. The same key with the same body returns the copy it
 * created (`created: false`); the same key with a different body or for a
 * different record is `conflict`. The per-user advisory lock serializes two
 * concurrent first uses of one key so exactly one of them inserts.
 */
export async function createLibraryCopy(
  db: CoreDatabase,
  input: {
    userId: string;
    itemId: string;
    idempotencyKey: string;
    copy: CreateLibraryCopy;
  },
): Promise<{ copy: LibraryCopy; created: boolean }> {
  const requestFingerprint = hashJson([
    input.itemId,
    input.copy.mediaCondition,
    input.copy.sleeveCondition,
    input.copy.location,
    input.copy.notes,
    input.copy.acquiredAt,
  ]);
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(
        hashtext(${input.userId}),
        hashtext(${input.idempotencyKey})
      )`,
    );
    const [replayed] = await transaction
      .select()
      .from(libraryCopies)
      .where(
        and(
          eq(libraryCopies.userId, input.userId),
          eq(libraryCopies.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (replayed) {
      if (
        replayed.libraryItemId !== input.itemId ||
        replayed.requestFingerprint !== requestFingerprint
      ) {
        throw new DatabaseCommandError(
          "conflict",
          "That idempotency key was already used to add a different copy.",
        );
      }
      return { copy: serializeLibraryCopy(replayed), created: false };
    }

    const item = await lockLibraryItem(transaction, input.userId, input.itemId);
    const [{ copyCount }] = await transaction
      .select({ copyCount: count() })
      .from(libraryCopies)
      .where(eq(libraryCopies.libraryItemId, item.id));
    const outcome = resolveCopyAddition(item.list, Number(copyCount));
    if (outcome.status === "rejected") {
      if (outcome.reason === "wishlist") {
        throw new DatabaseCommandError(
          "invalid_state",
          "A wishlist record has no copies. Move it to your collection to record the first one.",
        );
      }
      throw new DatabaseCommandError(
        "library_copy_limit",
        `A record holds up to ${MAX_LIBRARY_COPIES_PER_ITEM} copies. Remove one to record another.`,
      );
    }

    const now = new Date();
    const [inserted] = await transaction
      .insert(libraryCopies)
      .values({
        userId: input.userId,
        libraryItemId: item.id,
        releaseId: item.releaseId,
        mediaCondition: input.copy.mediaCondition,
        sleeveCondition: input.copy.sleeveCondition,
        location: input.copy.location,
        notes: input.copy.notes,
        acquiredAt: input.copy.acquiredAt,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint,
        updatedAt: now,
      })
      .returning();
    await transaction
      .update(libraryItems)
      .set({ updatedAt: now })
      .where(eq(libraryItems.id, item.id));
    return { copy: serializeLibraryCopy(inserted!), created: true };
  });
}

/**
 * Idempotent by identity: the same body applied twice leaves the copy in the
 * same state. The parent record's `updated_at` moves with the copy so the
 * `recent` sort surfaces a record whose inventory changed.
 */
export async function updateLibraryCopy(
  db: CoreDatabase,
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

/**
 * Removes one copy, the last one included (ADR-0024). The record's list is
 * untouched: a collection record whose last copy is removed stays in the
 * collection with none recorded until the user moves or removes it, because
 * clearing inventory is not the decision to stop owning the release. Any
 * `scan_confirmations.copy_id` that pointed at the copy clears itself while
 * the confirmation keeps every audit field. A repeat call is `not_found`,
 * like removing a record twice.
 */
export async function deleteLibraryCopy(
  db: CoreDatabase,
  scanDb: ScanDatabase,
  input: { userId: string; itemId: string; copyId: string },
): Promise<{ id: string }> {
  const deleted = await db.transaction(async (transaction) => {
    await lockLibraryItem(transaction, input.userId, input.itemId);
    const [row] = await transaction
      .delete(libraryCopies)
      .where(
        and(
          eq(libraryCopies.id, input.copyId),
          eq(libraryCopies.libraryItemId, input.itemId),
          eq(libraryCopies.userId, input.userId),
        ),
      )
      .returning({ id: libraryCopies.id });
    if (!row) {
      throw new DatabaseCommandError("not_found", "Library copy not found.");
    }
    await transaction
      .update(libraryItems)
      .set({ updatedAt: new Date() })
      .where(eq(libraryItems.id, input.itemId));
    return row;
  });

  await bestEffortClearScanConfirmationReference(scanDb, {
    copyId: deleted.id,
  });
  return deleted;
}

async function lockLibraryItem(
  transaction: CoreTransaction,
  userId: string,
  itemId: string,
) {
  const [item] = await transaction
    .select({
      id: libraryItems.id,
      list: libraryItems.list,
      releaseId: libraryItems.releaseId,
    })
    .from(libraryItems)
    .where(and(eq(libraryItems.id, itemId), eq(libraryItems.userId, userId)))
    .for("update");
  if (!item) {
    throw new DatabaseCommandError("not_found", "Library item not found.");
  }
  return item;
}

async function selectLibraryItemRows(
  db: Pick<CoreDatabase, "select">,
  input: {
    userId: string;
    list?: LibraryList;
    itemId?: string;
    itemIds?: readonly string[];
    favoritesOnly?: boolean;
    query?: string;
    orderBy?: SQL[];
    /** Keyset condition from `libraryOrdering().after`. */
    after?: SQL;
    limit: number;
  },
) {
  return db
    .select({
      id: libraryItems.id,
      list: libraryItems.list,
      notes: libraryItems.notes,
      confirmedFromScanId: libraryItems.confirmedFromScanId,
      favoritedAt: libraryItems.favoritedAt,
      createdAt: libraryItems.createdAt,
      updatedAt: libraryItems.updatedAt,
      // Sort keys as the database orders them, so a cursor built from the
      // last row of a page compares exactly on the next request.
      updatedAtCursor: cursorTimestamp(libraryItems.updatedAt),
      favoritedAtCursor: sql<
        string | null
      >`case when ${libraryItems.favoritedAt} is null then null else ${cursorTimestamp(libraryItems.favoritedAt)} end`,
      sortArtist,
      sortTitle,
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
      confirmedRelease: libraryItems.confirmedRelease,
    })
    .from(libraryItems)
    .innerJoin(releases, eq(releases.id, libraryItems.releaseId))
    .innerJoin(albums, eq(albums.id, releases.albumId))
    .where(
      and(
        eq(libraryItems.userId, input.userId),
        input.list ? eq(libraryItems.list, input.list) : undefined,
        input.itemId ? eq(libraryItems.id, input.itemId) : undefined,
        input.itemIds
          ? inArray(libraryItems.id, [...input.itemIds])
          : undefined,
        input.favoritesOnly ? isNotNull(libraryItems.favoritedAt) : undefined,
        searchCondition(input.query),
        input.after,
      ),
    )
    .orderBy(
      ...(input.orderBy ?? [
        desc(libraryItems.updatedAt),
        desc(libraryItems.id),
      ]),
    )
    .limit(Math.max(input.limit, 1));
}

async function attachCopiesAndSerialize(
  db: Pick<CoreDatabase, "select">,
  scanDb: Pick<ScanDatabase, "select">,
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
    scanDb,
    rows.map((row) => row.confirmedFromScanId),
  );

  return rows.map((row) => {
    const reviewed = row.confirmedRelease;
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
      favoritedAt: row.favoritedAt ? row.favoritedAt.toISOString() : null,
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
  db: Pick<ScanDatabase, "select">,
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
