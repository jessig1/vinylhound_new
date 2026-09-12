import { describe, expect, it } from "vitest";

import {
  MAX_PLAYLIST_ENTRIES,
  MAX_PLAYLISTS_PER_USER,
} from "@vinylhound/contracts";

import {
  hasPlaylistCapacity,
  hasPlaylistEntryCapacity,
  nextPlaylistPosition,
  normalizePlaylistName,
  resolvePlaylistOrder,
} from "./playlists.ts";

describe("playlist name normalization", () => {
  it("folds case, compatibility characters, and whitespace runs", () => {
    expect(normalizePlaylistName("  Road   Trip ")).toBe("road trip");
    expect(normalizePlaylistName("ＲＯＡＤ trip")).toBe("road trip");
  });

  it("keeps punctuation so numbered mixes stay distinct", () => {
    expect(normalizePlaylistName("Mix #1")).not.toBe(
      normalizePlaylistName("Mix #2"),
    );
  });
});

describe("playlist capacity", () => {
  it("allows one below the limit and refuses at it", () => {
    expect(hasPlaylistCapacity(MAX_PLAYLISTS_PER_USER - 1)).toBe(true);
    expect(hasPlaylistCapacity(MAX_PLAYLISTS_PER_USER)).toBe(false);
    expect(hasPlaylistEntryCapacity(MAX_PLAYLIST_ENTRIES - 1)).toBe(true);
    expect(hasPlaylistEntryCapacity(MAX_PLAYLIST_ENTRIES)).toBe(false);
  });
});

describe("playlist positions", () => {
  it("appends after the current maximum, starting from one", () => {
    expect(nextPlaylistPosition([])).toBe(1);
    // Gaps left by removed records are not reused.
    expect(nextPlaylistPosition([1, 4, 2])).toBe(5);
  });
});

describe("playlist reorder", () => {
  const current = ["a", "b", "c"];

  it("accepts a permutation of the current entries", () => {
    expect(resolvePlaylistOrder(current, ["c", "a", "b"])).toEqual({
      status: "ordered",
      entryIds: ["c", "a", "b"],
    });
  });

  it("replays the same order harmlessly", () => {
    expect(resolvePlaylistOrder(current, current)).toMatchObject({
      status: "ordered",
    });
  });

  it("rejects a repeated entry", () => {
    expect(resolvePlaylistOrder(current, ["a", "a", "b"])).toEqual({
      status: "rejected",
      reason: "duplicate_entry",
      entryId: "a",
    });
  });

  it("rejects an entry the playlist does not hold", () => {
    expect(resolvePlaylistOrder(current, ["a", "b", "c", "d"])).toEqual({
      status: "rejected",
      reason: "unknown_entry",
      entryId: "d",
    });
  });

  it("rejects an order that leaves an entry out", () => {
    expect(resolvePlaylistOrder(current, ["a", "b"])).toEqual({
      status: "rejected",
      reason: "missing_entry",
      entryId: "c",
    });
  });
});
