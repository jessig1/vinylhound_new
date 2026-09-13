import { z } from "zod";

import { LibrarySortSchema, type LibrarySort } from "@vinylhound/contracts";

import { DatabaseCommandError } from "./scan-repository.ts";

/**
 * Keyset continuation for library reads (ADR-0023). A cursor is the sort
 * key of the last row a page returned — the timestamp and id under
 * `recent`, the lower-cased effective artist, title and id under the name
 * sorts — so the next page is `WHERE key > cursor` (or `<` for the
 * descending recency sort) rather than an offset, which would duplicate or
 * skip rows whenever the library changed between two requests.
 *
 * The encoding is opaque to callers: base64url over a small JSON document
 * that records the sort it was issued under. Nothing about it is secret —
 * a caller can only ever page through their own records, and a tampered
 * cursor either fails to decode or names a position in the same ordering —
 * so it is validated for shape, not signed.
 */
const CURSOR_VERSION = 1;

const LibraryCursorPayloadSchema = z
  .object({
    v: z.literal(CURSOR_VERSION),
    sort: LibrarySortSchema,
    key: z.array(z.string()).min(2).max(3),
  })
  .strict();

export function encodeLibraryCursor(
  sort: LibrarySort,
  key: readonly string[],
): string {
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, sort, key }),
    "utf8",
  ).toString("base64url");
}

/**
 * Reads a cursor back for a read under `sort`, failing as `invalid_cursor`
 * (a `400` at the HTTP boundary) when it is malformed, from another cursor
 * version, or was issued under a different sort — its key would compare
 * against the wrong columns and silently return a wrong page.
 */
export function decodeLibraryCursor(
  cursor: string,
  sort: LibrarySort,
): string[] {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  const parsed = LibraryCursorPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw invalidCursor();
  }
  if (parsed.data.sort !== sort) {
    throw new DatabaseCommandError(
      "invalid_cursor",
      `The cursor was issued for sort=${parsed.data.sort} and cannot continue a sort=${sort} read.`,
    );
  }
  // `recent` continues from (stamp, id); the name sorts from (first, second, id).
  if (parsed.data.key.length !== (sort === "recent" ? 2 : 3)) {
    throw invalidCursor();
  }
  return parsed.data.key;
}

function invalidCursor() {
  return new DatabaseCommandError(
    "invalid_cursor",
    "The cursor could not be read. Start again from the first page.",
  );
}
