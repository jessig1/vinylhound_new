import { describe, expect, it } from "vitest";

import { ConfirmScanRequestSchema } from "./library.js";

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
});
