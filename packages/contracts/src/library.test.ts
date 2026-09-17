import { describe, expect, it } from "vitest";

import {
  ConfirmScanRequestSchema,
  CreateLibraryCopySchema,
  FavoritesQuerySchema,
  GetLibraryResponseSchema,
  LIBRARY_CURSOR_MAX_LENGTH,
  LIBRARY_PAGE_SIZE_DEFAULT,
  LIBRARY_PAGE_SIZE_MAX,
  LibraryItemResultSchema,
  LibraryQuerySchema,
  MAX_LIBRARY_COPIES_PER_ITEM,
  UpdateLibraryCopySchema,
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

describe("CreateLibraryCopySchema", () => {
  it("records a blank copy from an empty body", () => {
    expect(CreateLibraryCopySchema.parse({})).toEqual({
      mediaCondition: null,
      sleeveCondition: null,
      location: null,
      notes: null,
      acquiredAt: null,
    });
  });

  it("trims text fields and keeps a full grading", () => {
    expect(
      CreateLibraryCopySchema.parse({
        mediaCondition: "very_good_plus",
        sleeveCondition: "very_good",
        location: "  Shelf B ",
        notes: "Second pressing",
        acquiredAt: "2026-08-30",
      }),
    ).toEqual({
      mediaCondition: "very_good_plus",
      sleeveCondition: "very_good",
      location: "Shelf B",
      notes: "Second pressing",
      acquiredAt: "2026-08-30",
    });
  });

  it("rejects an unknown grade, a blank location, and unknown fields", () => {
    expect(() =>
      CreateLibraryCopySchema.parse({ mediaCondition: "sealed" }),
    ).toThrow();
    expect(() => CreateLibraryCopySchema.parse({ location: "  " })).toThrow();
    expect(() =>
      CreateLibraryCopySchema.parse({ acquiredAt: "2026-08-30T00:00:00Z" }),
    ).toThrow();
    expect(() =>
      CreateLibraryCopySchema.parse({ libraryItemId: "x" }),
    ).toThrow();
  });
});

describe("UpdateLibraryCopySchema", () => {
  it("accepts a partial update and leaves omitted fields undefined", () => {
    expect(
      UpdateLibraryCopySchema.parse({ location: "Crate 2", notes: null }),
    ).toEqual({ location: "Crate 2", notes: null });
  });

  it("requires at least one copy field", () => {
    expect(() => UpdateLibraryCopySchema.parse({})).toThrow();
  });

  it("rejects a field the copy does not have", () => {
    expect(() => UpdateLibraryCopySchema.parse({ list: "wishlist" })).toThrow();
  });
});

describe("LibraryItemResultSchema", () => {
  const item = {
    id: "4d5e6f7a-8b9c-4d0e-9f2a-3b4c5d6e7f10",
    list: "collection" as const,
    notes: null,
    release: {
      id: "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e09",
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
    confirmedFromScanId: null,
    coverImage: null,
    favoritedAt: null,
    createdAt: "2026-09-12T10:00:00.000Z",
    updatedAt: "2026-09-12T10:00:00.000Z",
  };
  const copy = (index: number) => ({
    id: `5e6f7a8b-9c0d-4e1f-8a3b-${String(index).padStart(12, "0")}`,
    mediaCondition: null,
    sleeveCondition: null,
    location: null,
    notes: null,
    acquiredAt: null,
    createdAt: "2026-09-12T10:00:00.000Z",
    updatedAt: "2026-09-12T10:00:00.000Z",
  });

  it("allows a collection record with no copies recorded (ADR-0024)", () => {
    expect(
      LibraryItemResultSchema.parse({ ...item, copyCount: 0, copies: [] }),
    ).toMatchObject({ list: "collection", copyCount: 0 });
  });

  it("bounds copies at the per-item cap", () => {
    const full = Array.from({ length: MAX_LIBRARY_COPIES_PER_ITEM }, (_, i) =>
      copy(i),
    );
    expect(
      LibraryItemResultSchema.parse({
        ...item,
        copyCount: full.length,
        copies: full,
      }).copies,
    ).toHaveLength(MAX_LIBRARY_COPIES_PER_ITEM);
    expect(() =>
      LibraryItemResultSchema.parse({
        ...item,
        copyCount: full.length + 1,
        copies: [...full, copy(full.length)],
      }),
    ).toThrow();
  });
});

describe("LibraryQuerySchema", () => {
  it("defaults sort to recent, the page size to the default, and omits an empty query", () => {
    expect(LibraryQuerySchema.parse({ list: "collection" })).toEqual({
      list: "collection",
      q: undefined,
      sort: "recent",
      cursor: undefined,
      limit: LIBRARY_PAGE_SIZE_DEFAULT,
    });
  });

  it("reads the page size from its query-string text and bounds it", () => {
    expect(
      LibraryQuerySchema.parse({ list: "collection", limit: "25" }),
    ).toMatchObject({ limit: 25 });
    expect(
      LibraryQuerySchema.parse({
        list: "collection",
        limit: String(LIBRARY_PAGE_SIZE_MAX),
      }),
    ).toMatchObject({ limit: LIBRARY_PAGE_SIZE_MAX });
    for (const limit of ["0", "-1", "2.5", "abc", "", "101"]) {
      expect(
        LibraryQuerySchema.safeParse({ list: "collection", limit }).success,
        `limit=${JSON.stringify(limit)}`,
      ).toBe(false);
    }
  });

  it("passes a continuation cursor through opaquely", () => {
    expect(
      LibraryQuerySchema.parse({ list: "wishlist", cursor: "eyJ2IjoxfQ" }),
    ).toMatchObject({ cursor: "eyJ2IjoxfQ" });
    expect(
      LibraryQuerySchema.safeParse({ list: "wishlist", cursor: "" }).success,
    ).toBe(false);
    expect(
      LibraryQuerySchema.safeParse({
        list: "wishlist",
        cursor: "c".repeat(LIBRARY_CURSOR_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
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
    ).toEqual({ q: "miles", sort: "artist", limit: LIBRARY_PAGE_SIZE_DEFAULT });
    expect(FavoritesQuerySchema.parse({})).toEqual({
      q: undefined,
      sort: "recent",
      cursor: undefined,
      limit: LIBRARY_PAGE_SIZE_DEFAULT,
    });
    expect(FavoritesQuerySchema.safeParse({ list: "collection" }).success).toBe(
      false,
    );
  });
});

describe("GetLibraryResponseSchema", () => {
  it("carries a continuation cursor that is null on the last page", () => {
    expect(
      GetLibraryResponseSchema.parse({
        list: "collection",
        items: [],
        nextCursor: null,
      }),
    ).toEqual({ list: "collection", items: [], nextCursor: null });
    expect(
      GetLibraryResponseSchema.parse({
        list: "collection",
        items: [],
        nextCursor: "eyJ2IjoxfQ",
      }).nextCursor,
    ).toBe("eyJ2IjoxfQ");
    // A page without the cursor field is not what this version emits.
    expect(
      GetLibraryResponseSchema.safeParse({ list: "collection", items: [] })
        .success,
    ).toBe(false);
  });
});
