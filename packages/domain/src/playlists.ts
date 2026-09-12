import {
  MAX_PLAYLIST_ENTRIES,
  MAX_PLAYLISTS_PER_USER,
} from "@vinylhound/contracts";

/**
 * Playlist names are unique per user after normalization, so "Road Trip" and
 * "road  trip" are the same playlist. Unlike release identity this keeps
 * punctuation: "Mix #1" and "Mix #2" are different names.
 */
export function normalizePlaylistName(name: string) {
  return name
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
}

export function hasPlaylistCapacity(playlistCount: number) {
  return playlistCount < MAX_PLAYLISTS_PER_USER;
}

export function hasPlaylistEntryCapacity(entryCount: number) {
  return entryCount < MAX_PLAYLIST_ENTRIES;
}

/**
 * A new entry goes at the end. Positions are unique and ascending but need
 * not be contiguous, because removing a saved record deletes its entries
 * without renumbering the rest; appending after the current maximum keeps
 * the order stable without touching existing rows.
 */
export function nextPlaylistPosition(positions: readonly number[]) {
  return positions.reduce((max, position) => Math.max(max, position), 0) + 1;
}

export type PlaylistOrderOutcome =
  | { status: "ordered"; entryIds: string[] }
  | {
      status: "rejected";
      reason: "duplicate_entry" | "unknown_entry" | "missing_entry";
      entryId: string;
    };

/**
 * A reorder must name every current entry exactly once. The rule protects
 * concurrent editors: a device holding a stale view cannot silently drop an
 * entry another device just added, or resurrect one it just removed — the
 * request is rejected and the client refetches instead. Replaying the same
 * order is harmless and converges.
 */
export function resolvePlaylistOrder(
  currentEntryIds: readonly string[],
  requestedEntryIds: readonly string[],
): PlaylistOrderOutcome {
  const current = new Set(currentEntryIds);
  const seen = new Set<string>();
  for (const entryId of requestedEntryIds) {
    if (seen.has(entryId)) {
      return { status: "rejected", reason: "duplicate_entry", entryId };
    }
    if (!current.has(entryId)) {
      return { status: "rejected", reason: "unknown_entry", entryId };
    }
    seen.add(entryId);
  }
  for (const entryId of currentEntryIds) {
    if (!seen.has(entryId)) {
      return { status: "rejected", reason: "missing_entry", entryId };
    }
  }
  return { status: "ordered", entryIds: [...requestedEntryIds] };
}
