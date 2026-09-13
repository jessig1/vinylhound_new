import { describe, expect, it } from "vitest";

import type { LibraryItemResult } from "@vinylhound/contracts";

import {
  csvEscape,
  libraryCsvHeader,
  libraryCsvLine,
  LIBRARY_CSV_COLUMNS,
} from "./library-csv.ts";

const item: LibraryItemResult = {
  id: "00000000-0000-4000-8000-000000000001",
  list: "collection",
  notes: 'Gatefold, "first" press\nsigned',
  release: {
    id: "00000000-0000-4000-8000-000000000002",
    artist: "Crosby, Stills & Nash",
    title: "Déjà Vu",
    releaseYear: 1970,
    label: "Atlantic",
    catalogNumber: "SD 7200",
    barcode: null,
    releaseDate: "1970-03-11",
    country: "US",
    format: '12" Vinyl',
    packaging: null,
    releaseStatus: null,
    catalogReference: null,
  },
  copyCount: 2,
  copies: [],
  confirmedFromScanId: null,
  coverImage: null,
  favoritedAt: null,
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
};

describe("library CSV", () => {
  it("writes the header row in column order", () => {
    expect(libraryCsvHeader()).toBe(`${LIBRARY_CSV_COLUMNS.join(",")}\r\n`);
  });

  it("quotes only the fields that need it and doubles embedded quotes", () => {
    expect(libraryCsvLine(item)).toBe(
      '"Crosby, Stills & Nash",Déjà Vu,1970,Atlantic,"12"" Vinyl",US,collection,"Gatefold, ""first"" press\nsigned",2\r\n',
    );
  });

  it("writes empty fields for missing release details", () => {
    expect(
      libraryCsvLine({
        ...item,
        notes: null,
        release: {
          ...item.release,
          releaseYear: null,
          label: null,
          format: null,
          country: null,
        },
        copyCount: 0,
        list: "wishlist",
      }),
    ).toBe('"Crosby, Stills & Nash",Déjà Vu,,,,,wishlist,,0\r\n');
  });

  it("leaves plain values untouched", () => {
    expect(csvEscape("Kind of Blue")).toBe("Kind of Blue");
    expect(csvEscape("")).toBe("");
    expect(csvEscape("a\rb")).toBe('"a\rb"');
  });
});
