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
import { resolveFavoritedAt } from "@vinylhound/domain";

import type { Database } from "./database.ts";
import { decodeLibraryCursor, encodeLibraryCursor } from "./library-cursor.ts";
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
  db: Pick<Database, "select">,
  input: LibraryPageInput & { list: LibraryList },
): Promise<GetLibraryResponse> {
  const page = await selectLibraryItemPage(db, {
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
  db: Pick<Database, "select">,
  input: LibraryPageInput,
): Promise<GetFavoritesResponse> {
  return selectLibraryItemPage(db, {
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
  db: Pick<Database, "select">,
  input: Omit<LibraryPageInput, "cursor" | "limit"> & {
    list: LibraryList;
    pageSize?: number;
  },
): AsyncGenerator<LibraryItemResult[], void, undefined> {
  let cursor: string | undefined;
  do {
    const page = await listLibraryItemsForUser(db, {
      ...input,
      cursor,
      limit: input.pageSize ?? LIBRARY_PAGE_SIZE_MAX,
    });
    if (page.items.length) yield page.items;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}

async function selectLibraryItemPage(
  db: Pick<Database, "select">,
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
  const items = await attachCopiesAndSerialize(db, input.userId, pageRows);
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
  db: Pick<Database, "select">,
  input: { userId: string; itemIds: readonly string[] },
): Promise<Map<string, LibraryItemResult>> {
  if (!input.itemIds.length) return new Map();
  const rows = await selectLibraryItemRows(db, {
    userId: input.userId,
    itemIds: input.itemIds,
    limit: input.itemIds.length,
  });
  const items = await attachCopiesAndSerialize(db, input.userId, rows);
  return new Map(items.map((item) => [item.id, item]));
}

export async function getLibraryItemForUser(
  db: Database,
  input: { userId: string; itemId: string },
): Promise<LibraryItemResult> {
  const rows = await selectLibraryItemRows(db, {
    userId: input.userId,
    itemId: input.itemId,
    limit: 1,
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

/**
 * The artist and title a library item displays: the values the user
 * confirmed on the scan it came from when there was one, else the shared
 * album row (ADR-0012). Search and the name sorts evaluate these in SQL so
 * they see every row; `attachCopiesAndSerialize` resolves the same
 * preference in application code for the fields it returns.
 */
const effectiveArtist = sql<string>`coalesce(${scanConfirmations.reviewedRelease}->>'artist', ${albums.artist})`;
const effectiveTitle = sql<string>`coalesce(${scanConfirmations.reviewedRelease}->>'title', ${albums.title})`;
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
