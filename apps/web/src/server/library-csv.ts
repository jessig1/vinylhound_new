import type { LibraryItemResult } from "@vinylhound/contracts";

/**
 * The CSV shape `GET /library/export` streams (ADR-0012): one row per saved
 * record with the fields a spreadsheet can use, no per-copy detail and no
 * catalog reference. Lines end in CRLF per RFC 4180; a field is quoted only
 * when it contains a comma, quote or line break, with quotes doubled.
 */
export const LIBRARY_CSV_COLUMNS = [
  "artist",
  "title",
  "releaseYear",
  "label",
  "format",
  "country",
  "list",
  "notes",
  "copyCount",
] as const;

export const CSV_LINE_END = "\r\n";

export function libraryCsvHeader() {
  return LIBRARY_CSV_COLUMNS.join(",") + CSV_LINE_END;
}

export function libraryCsvLine(item: LibraryItemResult) {
  return (
    [
      item.release.artist,
      item.release.title,
      item.release.releaseYear?.toString() ?? "",
      item.release.label ?? "",
      item.release.format ?? "",
      item.release.country ?? "",
      item.list,
      item.notes ?? "",
      item.copyCount.toString(),
    ]
      .map(csvEscape)
      .join(",") + CSV_LINE_END
  );
}

export function csvEscape(value: string) {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
