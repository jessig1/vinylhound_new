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
