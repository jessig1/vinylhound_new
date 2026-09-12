import { describe, expect, it } from "vitest";

import {
  AddPlaylistEntrySchema,
  CreatePlaylistSchema,
  MAX_PLAYLIST_ENTRIES,
  PLAYLIST_NAME_MAX_LENGTH,
  PlaylistDetailSchema,
  UpdatePlaylistSchema,
} from "./playlist.ts";

const entryId = "00000000-0000-4000-8000-000000000001";
const otherEntryId = "00000000-0000-4000-8000-000000000002";

describe("CreatePlaylistSchema", () => {
  it("trims the name and bounds its length", () => {
    expect(CreatePlaylistSchema.parse({ name: "  Road trip  " })).toEqual({
      name: "Road trip",
    });
    expect(CreatePlaylistSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(
      CreatePlaylistSchema.safeParse({
        name: "x".repeat(PLAYLIST_NAME_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(
      CreatePlaylistSchema.safeParse({ name: "Road trip", public: true })
        .success,
    ).toBe(false);
  });
});

describe("UpdatePlaylistSchema", () => {
  it("accepts a rename, a reorder, or both", () => {
    expect(UpdatePlaylistSchema.parse({ name: "Sunday" })).toEqual({
      name: "Sunday",
    });
    expect(
      UpdatePlaylistSchema.parse({ entryIds: [otherEntryId, entryId] }),
    ).toEqual({ entryIds: [otherEntryId, entryId] });
    expect(
      UpdatePlaylistSchema.parse({ name: "Sunday", entryIds: [] }),
    ).toEqual({ name: "Sunday", entryIds: [] });
  });

  it("requires at least one field", () => {
    expect(UpdatePlaylistSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an order that repeats an entry", () => {
    expect(
      UpdatePlaylistSchema.safeParse({ entryIds: [entryId, entryId] }).success,
    ).toBe(false);
  });

  it("caps the order at the playlist entry limit", () => {
    const ids = Array.from(
      { length: MAX_PLAYLIST_ENTRIES + 1 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    expect(UpdatePlaylistSchema.safeParse({ entryIds: ids }).success).toBe(
      false,
    );
  });
});

describe("AddPlaylistEntrySchema", () => {
  it("references a saved record by library item id only", () => {
    expect(AddPlaylistEntrySchema.parse({ libraryItemId: entryId })).toEqual({
      libraryItemId: entryId,
    });
    // A playlist holds saved records, never bare releases or catalog hits.
    expect(
      AddPlaylistEntrySchema.safeParse({ releaseId: entryId }).success,
    ).toBe(false);
  });
});

describe("PlaylistDetailSchema", () => {
  it("carries ordered entries each wrapping a full library item", () => {
    const parsed = PlaylistDetailSchema.parse({
      id: "00000000-0000-4000-8000-000000000010",
      name: "Road trip",
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z",
      entries: [
        {
          id: entryId,
          position: 3,
          addedAt: "2026-09-12T00:00:00.000Z",
          item: {
            id: "00000000-0000-4000-8000-000000000020",
            list: "wishlist",
            notes: null,
            release: {
              id: "00000000-0000-4000-8000-000000000030",
              artist: "Miles Davis",
              title: "Kind of Blue",
              releaseYear: 1959,
              label: null,
              catalogNumber: null,
              barcode: null,
              releaseDate: null,
              country: null,
              format: null,
              packaging: null,
              releaseStatus: null,
              catalogReference: null,
            },
            copyCount: 0,
            copies: [],
            confirmedFromScanId: null,
            coverImage: null,
            favoritedAt: null,
            createdAt: "2026-09-12T00:00:00.000Z",
            updatedAt: "2026-09-12T00:00:00.000Z",
          },
        },
      ],
    });
    // Positions are ascending but need not start at one or be contiguous.
    expect(parsed.entries[0]).toMatchObject({ position: 3 });
  });
});
