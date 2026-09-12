import { describe, expect, it } from "vitest";

import {
  ConfirmScanRequestSchema,
  FavoritesQuerySchema,
  LibraryQuerySchema,
  UpdateLibraryItemSchema,
} from "./library.ts";

describe("ConfirmScanRequestSchema", () => {
  it("accepts a corrected candidate and target list", () => {
    expect(
      ConfirmScanRequestSchema.parse({
        selectedCandidateId: "00000000-0000-4000-8000-000000000001",
        artist: "  Miles Davis ",
        title: "Kind of Blue",
        releaseYear: 1959,
        label: "Columbia",
        catalogNumber: "CS 8163",
        barcode: null,
        list: "collection",
        notes: null,
      }),
    ).toMatchObject({ artist: "Miles Davis", list: "collection" });
  });

  it("accepts catalog provenance and physical-copy details", () => {
    expect(
      ConfirmScanRequestSchema.parse({
        selectedCandidateId: null,
        artist: "Miles Davis",
        title: "Kind of Blue",
        releaseYear: 1959,
        label: "Columbia",
        catalogNumber: "CS 8163",
        barcode: null,
        releaseDate: "1959-08-17",
        country: "US",
        format: '12" Vinyl',
        catalogReference: {
          provider: "musicbrainz",
          releaseGroupId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          releaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          sourceUrl:
            "https://musicbrainz.org/release/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          fetchedAt: "2026-08-31T12:00:00.000Z",
        },
        list: "collection",
        notes: null,
        copy: { location: "Shelf A", mediaCondition: "very_good_plus" },
      }),
    ).toMatchObject({
      catalogReference: { provider: "musicbrainz" },
      copy: { location: "Shelf A" },
    });
  });

  it("rejects physical-copy details on a wishlist entry", () => {
    expect(() =>
      ConfirmScanRequestSchema.parse({
        selectedCandidateId: null,
        artist: "Miles Davis",
        title: "Kind of Blue",
        releaseYear: null,
        label: null,
        catalogNumber: null,
        barcode: null,
        list: "wishlist",
        notes: null,
        copy: { location: "Shelf A" },
      }),
    ).toThrow();
  });

  it("rejects empty corrected identity fields", () => {
    expect(() =>
      ConfirmScanRequestSchema.parse({
        selectedCandidateId: null,
        artist: " ",
        title: "Kind of Blue",
        releaseYear: null,
        label: null,
        catalogNumber: null,
        barcode: null,
        list: "wishlist",
        notes: null,
      }),
    ).toThrow();
  });

  it("accepts an explicit wishlist-to-owned conversion", () => {
    expect(
      UpdateLibraryItemSchema.parse({
        list: "collection",
      }),
    ).toMatchObject({ list: "collection" });
  });

  it("accepts a notes-only update", () => {
    expect(
      UpdateLibraryItemSchema.parse({
        notes: "Signed copy",
      }),
    ).toMatchObject({ notes: "Signed copy" });
  });

  it("accepts a favorite-only toggle in either direction", () => {
    expect(UpdateLibraryItemSchema.parse({ favorite: true })).toEqual({
      favorite: true,
    });
    expect(UpdateLibraryItemSchema.parse({ favorite: false })).toEqual({
      favorite: false,
    });
  });

  it("requires a direct library update to change something", () => {
    expect(() => UpdateLibraryItemSchema.parse({})).toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() =>
      UpdateLibraryItemSchema.parse({
        list: "collection",
        copy: { location: "Shelf B" },
      }),
    ).toThrow();
  });
});

describe("LibraryQuerySchema", () => {
  it("defaults sort to recent and omits an empty query", () => {
    expect(LibraryQuerySchema.parse({ list: "collection" })).toEqual({
      list: "collection",
      q: undefined,
      sort: "recent",
    });
  });

  it("trims a provided query and accepts a sort value", () => {
    expect(
      LibraryQuerySchema.parse({
        list: "wishlist",
        q: "  miles davis  ",
        sort: "artist",
      }),
    ).toMatchObject({ q: "miles davis", sort: "artist" });
  });

  it("rejects an invalid sort value", () => {
    expect(() =>
      LibraryQuerySchema.parse({ list: "collection", sort: "cost" }),
    ).toThrow();
  });

  it("rejects a query longer than the allowed length", () => {
    expect(() =>
      LibraryQuerySchema.parse({ list: "collection", q: "a".repeat(201) }),
    ).toThrow();
  });
});

describe("FavoritesQuerySchema", () => {
  it("takes search and sort but no list, since favorites span both", () => {
    expect(
      FavoritesQuerySchema.parse({ q: "  miles ", sort: "artist" }),
    ).toEqual({ q: "miles", sort: "artist" });
    expect(FavoritesQuerySchema.parse({})).toEqual({
      q: undefined,
      sort: "recent",
    });
    expect(FavoritesQuerySchema.safeParse({ list: "collection" }).success).toBe(
      false,
    );
  });
});
