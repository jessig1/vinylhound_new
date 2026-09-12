import { and, asc, count, desc, eq, ne, sql } from "drizzle-orm";

import {
  MAX_PLAYLIST_ENTRIES,
  MAX_PLAYLISTS_PER_USER,
  type ListPlaylistsResponse,
  type PlaylistDetail,
  type UpdatePlaylist,
} from "@vinylhound/contracts";
import {
  hasPlaylistCapacity,
  hasPlaylistEntryCapacity,
  nextPlaylistPosition,
  normalizePlaylistName,
  resolvePlaylistOrder,
} from "@vinylhound/domain";

import type { Database } from "./database.ts";
import { getLibraryItemsByIdForUser } from "./library-repository.ts";
import type { DatabaseTransaction } from "./release-resolution.ts";
import { DatabaseCommandError } from "./scan-repository.ts";
import { libraryItems, playlistEntries, playlists } from "./schema.ts";

/**
 * User-owned ordered playlists of saved release references (ADR-0021,
 * roadmap P3.3 Task 2). Every entry points at one of the user's own
 * `library_items` rows, so a playlist can only hold music the user has
 * saved, and removing a saved record removes it from every playlist by
 * cascade. Every mutation takes a row lock on the playlist first, so
 * concurrent edits to one playlist serialize instead of interleaving.
 */
export async function listPlaylistsForUser(
  db: Database,
  input: { userId: string },
): Promise<ListPlaylistsResponse> {
  const rows = await db
    .select({
      id: playlists.id,
      name: playlists.name,
      createdAt: playlists.createdAt,
      updatedAt: playlists.updatedAt,
      entryCount: count(playlistEntries.id),
    })
    .from(playlists)
    .leftJoin(playlistEntries, eq(playlistEntries.playlistId, playlists.id))
    .where(eq(playlists.userId, input.userId))
    .groupBy(playlists.id)
    .orderBy(desc(playlists.updatedAt), asc(playlists.id))
    .limit(MAX_PLAYLISTS_PER_USER);
  return {
    playlists: rows.map((row) => ({
      id: row.id,
      name: row.name,
      entryCount: row.entryCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

/**
 * Which of the user's playlists hold a given saved record, with the entry
 * that holds it, so a record's page can offer "add to" and "remove from"
 * without loading every playlist in full.
 */
export async function listPlaylistMembershipForItem(
  db: Database,
  input: { userId: string; libraryItemId: string },
): Promise<{ playlistId: string; entryId: string }[]> {
  const rows = await db
    .select({
      playlistId: playlistEntries.playlistId,
      entryId: playlistEntries.id,
    })
    .from(playlistEntries)
    .where(
      and(
        eq(playlistEntries.userId, input.userId),
        eq(playlistEntries.libraryItemId, input.libraryItemId),
      ),
    )
    .limit(MAX_PLAYLISTS_PER_USER);
  return rows;
}

export async function getPlaylistForUser(
  db: Database,
  input: { userId: string; playlistId: string },
): Promise<PlaylistDetail> {
  const [playlist] = await db
    .select()
    .from(playlists)
    .where(
      and(
        eq(playlists.id, input.playlistId),
        eq(playlists.userId, input.userId),
      ),
    );
  if (!playlist) {
    throw new DatabaseCommandError("not_found", "Playlist not found.");
  }
  return readPlaylistDetail(db, input.userId, playlist);
}

/**
 * Idempotent by identity: names are unique per user after normalization, so
 * creating "Road Trip" again returns the existing playlist rather than a
 * second one. No `Idempotency-Key` is needed, matching `POST /library`.
 */
export async function createPlaylist(
  db: Database,
  input: { userId: string; name: string },
): Promise<{ playlist: PlaylistDetail; created: boolean }> {
  const normalizedName = normalizePlaylistName(input.name);

  return db.transaction(async (transaction) => {
    // Serializes creates per user so the capacity check cannot be raced past
    // by two concurrent requests, each seeing one free slot.
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext('playlists'), hashtext(${input.userId}))`,
    );

    const existing = await transaction.query.playlists.findFirst({
      where: and(
        eq(playlists.userId, input.userId),
        eq(playlists.normalizedName, normalizedName),
      ),
    });
    if (existing) {
      return {
        playlist: await readPlaylistDetail(transaction, input.userId, existing),
        created: false,
      };
    }

    const [total] = await transaction
      .select({ value: count() })
      .from(playlists)
      .where(eq(playlists.userId, input.userId));
    if (!hasPlaylistCapacity(total?.value ?? 0)) {
      throw new DatabaseCommandError(
        "playlist_limit",
        `You can keep up to ${MAX_PLAYLISTS_PER_USER} playlists. Delete one to make room.`,
      );
    }

    const now = new Date();
    const [inserted] = await transaction
      .insert(playlists)
      .values({
        userId: input.userId,
        name: input.name,
        normalizedName,
        updatedAt: now,
      })
      .returning();
    if (!inserted) {
      throw new DatabaseCommandError(
        "conflict",
        "The playlist could not be created.",
      );
    }
    return {
      playlist: await readPlaylistDetail(transaction, input.userId, inserted),
      created: true,
    };
  });
}

export async function updatePlaylist(
  db: Database,
  input: { userId: string; playlistId: string; update: UpdatePlaylist },
): Promise<PlaylistDetail> {
  return db.transaction(async (transaction) => {
    const playlist = await lockPlaylist(
      transaction,
      input.userId,
      input.playlistId,
    );
    const now = new Date();

    if (input.update.name !== undefined) {
      const normalizedName = normalizePlaylistName(input.update.name);
      const clash = await transaction.query.playlists.findFirst({
        where: and(
          eq(playlists.userId, input.userId),
          eq(playlists.normalizedName, normalizedName),
          ne(playlists.id, playlist.id),
        ),
      });
      if (clash) {
        throw new DatabaseCommandError(
          "conflict",
          `You already have a playlist named “${clash.name}”.`,
        );
      }
      await transaction
        .update(playlists)
        .set({ name: input.update.name, normalizedName, updatedAt: now })
        .where(eq(playlists.id, playlist.id));
    }

    if (input.update.entryIds !== undefined) {
      const entries = await transaction
        .select({ id: playlistEntries.id, position: playlistEntries.position })
        .from(playlistEntries)
        .where(eq(playlistEntries.playlistId, playlist.id))
        .orderBy(asc(playlistEntries.position));
      const outcome = resolvePlaylistOrder(
        entries.map((entry) => entry.id),
        input.update.entryIds,
      );
      if (outcome.status === "rejected") {
        throw new DatabaseCommandError(
          "conflict",
          outcome.reason === "missing_entry"
            ? "The new order leaves out an entry. Reload the playlist and try again."
            : outcome.reason === "unknown_entry"
              ? "The new order names an entry this playlist no longer holds. Reload the playlist and try again."
              : "The new order repeats an entry.",
        );
      }
      if (entries.length) {
        // Positions are unique per playlist and the constraint is checked
        // per row, so renumbering in place would collide mid-statement.
        // Lift every row above the current maximum first, then assign the
        // final 1..n order in one pass; nothing in either step can overlap.
        const offset = nextPlaylistPosition(
          entries.map((entry) => entry.position),
        );
        await transaction
          .update(playlistEntries)
          .set({ position: sql`${playlistEntries.position} + ${offset}` })
          .where(eq(playlistEntries.playlistId, playlist.id));
        const cases = sql.join(
          outcome.entryIds.map(
            (entryId, index) =>
              sql`when ${entryId}::uuid then ${sql.raw(String(index + 1))}`,
          ),
          sql` `,
        );
        await transaction
          .update(playlistEntries)
          .set({ position: sql`case ${playlistEntries.id} ${cases} end` })
          .where(eq(playlistEntries.playlistId, playlist.id));
      }
      await transaction
        .update(playlists)
        .set({ updatedAt: now })
        .where(eq(playlists.id, playlist.id));
    }

    const [updated] = await transaction
      .select()
      .from(playlists)
      .where(eq(playlists.id, playlist.id));
    if (!updated) {
      throw new DatabaseCommandError(
        "invalid_state",
        "The updated playlist could not be read back.",
      );
    }
    return readPlaylistDetail(transaction, input.userId, updated);
  });
}

export async function deletePlaylist(
  db: Database,
  input: { userId: string; playlistId: string },
): Promise<{ id: string }> {
  return db.transaction(async (transaction) => {
    const playlist = await lockPlaylist(
      transaction,
      input.userId,
      input.playlistId,
    );
    const [deleted] = await transaction
      .delete(playlists)
      .where(eq(playlists.id, playlist.id))
      .returning({ id: playlists.id });
    if (!deleted) {
      throw new DatabaseCommandError("not_found", "Playlist not found.");
    }
    return deleted;
  });
}

/**
 * Appends one of the user's saved records. Idempotent by identity: a
 * playlist holds each saved release at most once, so adding it again
 * returns the playlist unchanged. A record the user does not own reads as
 * not found, never as someone else's.
 */
export async function addPlaylistEntry(
  db: Database,
  input: { userId: string; playlistId: string; libraryItemId: string },
): Promise<{ playlist: PlaylistDetail; created: boolean }> {
  return db.transaction(async (transaction) => {
    const playlist = await lockPlaylist(
      transaction,
      input.userId,
      input.playlistId,
    );
    const [item] = await transaction
      .select({ id: libraryItems.id })
      .from(libraryItems)
      .where(
        and(
          eq(libraryItems.id, input.libraryItemId),
          eq(libraryItems.userId, input.userId),
        ),
      );
    if (!item) {
      throw new DatabaseCommandError("not_found", "Library item not found.");
    }

    const entries = await transaction
      .select({
        id: playlistEntries.id,
        libraryItemId: playlistEntries.libraryItemId,
        position: playlistEntries.position,
      })
      .from(playlistEntries)
      .where(eq(playlistEntries.playlistId, playlist.id));
    if (entries.some((entry) => entry.libraryItemId === item.id)) {
      return {
        playlist: await readPlaylistDetail(transaction, input.userId, playlist),
        created: false,
      };
    }
    if (!hasPlaylistEntryCapacity(entries.length)) {
      throw new DatabaseCommandError(
        "playlist_entry_limit",
        `A playlist holds up to ${MAX_PLAYLIST_ENTRIES} records. Remove one to make room.`,
      );
    }

    const now = new Date();
    await transaction.insert(playlistEntries).values({
      playlistId: playlist.id,
      userId: input.userId,
      libraryItemId: item.id,
      position: nextPlaylistPosition(entries.map((entry) => entry.position)),
    });
    const [updated] = await transaction
      .update(playlists)
      .set({ updatedAt: now })
      .where(eq(playlists.id, playlist.id))
      .returning();
    return {
      playlist: await readPlaylistDetail(
        transaction,
        input.userId,
        updated ?? playlist,
      ),
      created: true,
    };
  });
}

export async function removePlaylistEntry(
  db: Database,
  input: { userId: string; playlistId: string; entryId: string },
): Promise<{ id: string }> {
  return db.transaction(async (transaction) => {
    const playlist = await lockPlaylist(
      transaction,
      input.userId,
      input.playlistId,
    );
    const [deleted] = await transaction
      .delete(playlistEntries)
      .where(
        and(
          eq(playlistEntries.id, input.entryId),
          eq(playlistEntries.playlistId, playlist.id),
        ),
      )
      .returning({ id: playlistEntries.id });
    if (!deleted) {
      throw new DatabaseCommandError("not_found", "Playlist entry not found.");
    }
    await transaction
      .update(playlists)
      .set({ updatedAt: new Date() })
      .where(eq(playlists.id, playlist.id));
    return deleted;
  });
}

async function lockPlaylist(
  transaction: DatabaseTransaction,
  userId: string,
  playlistId: string,
) {
  const [playlist] = await transaction
    .select()
    .from(playlists)
    .where(and(eq(playlists.id, playlistId), eq(playlists.userId, userId)))
    .for("update");
  if (!playlist) {
    throw new DatabaseCommandError("not_found", "Playlist not found.");
  }
  return playlist;
}

async function readPlaylistDetail(
  db: Pick<Database, "select">,
  userId: string,
  playlist: typeof playlists.$inferSelect,
): Promise<PlaylistDetail> {
  const entries = await db
    .select({
      id: playlistEntries.id,
      libraryItemId: playlistEntries.libraryItemId,
      position: playlistEntries.position,
      createdAt: playlistEntries.createdAt,
    })
    .from(playlistEntries)
    .where(eq(playlistEntries.playlistId, playlist.id))
    .orderBy(asc(playlistEntries.position), asc(playlistEntries.id))
    .limit(MAX_PLAYLIST_ENTRIES);
  const items = await getLibraryItemsByIdForUser(db, {
    userId,
    itemIds: entries.map((entry) => entry.libraryItemId),
  });
  return {
    id: playlist.id,
    name: playlist.name,
    createdAt: playlist.createdAt.toISOString(),
    updatedAt: playlist.updatedAt.toISOString(),
    entries: entries.map((entry) => {
      const item = items.get(entry.libraryItemId);
      if (!item) {
        // The FK cascade makes this unreachable; surfacing it beats quietly
        // rendering a shorter playlist than the user built.
        throw new DatabaseCommandError(
          "invalid_state",
          "A playlist entry no longer points at a saved record.",
        );
      }
      return {
        id: entry.id,
        position: entry.position,
        addedAt: entry.createdAt.toISOString(),
        item,
      };
    }),
  };
}
