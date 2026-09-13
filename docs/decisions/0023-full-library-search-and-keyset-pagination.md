# ADR-0023: Library reads search, sort and page in SQL over the effective release, continued by keyset cursors

- Status: Accepted
- Date: 2026-09-12
- Supersedes: the "after the 100-row fetch" tradeoff in
  [ADR-0012](0012-library-search-filter-export.md); its rule that search and
  sort follow the displayed release stands
- Builds on: [ADR-0012](0012-library-search-filter-export.md),
  [ADR-0021](0021-favorites-and-playlists.md),
  [ADR-0022](0022-contract-versioning-and-compatibility.md)

## Context

Roadmap P3.4 Task 1 asks to replace search within the first 100 fetched rows
with full-library search, stable cursor pagination and sorting, and export of
all matching records, while preserving user-corrected artist/title matching
and ordering.

Every list read — `GET /library`, `GET /library/favorites`, the CSV export,
and the three pages behind them — ran one query capped at 100 rows and then
filtered and sorted in application code (ADR-0012). ADR-0012 chose that
because the artist and title a record displays are not always the shared
`albums` row: when the record was confirmed from a scan, the user's corrected
values in `scan_confirmations.reviewed_release` (JSONB) win, and a `WHERE`
against `albums` would miss a correction the user can see. It flagged the
consequence: a search only narrowed within one page, an export was the same
page, and both would need revisiting "if a user's library ever approaches
the 100-item cap" — which the favorites page (ADR-0021) then inherited.

Three constraints shape the replacement:

1. **The effective release must stay the search and sort key.** A corrected
   identification is searchable and ordered by the name the user confirmed,
   not by a row two other users' copies may share.
2. **Pages must be stable under change.** The `recent` sort keys on
   `updated_at`, which every edit moves; offset pagination over it duplicates
   or skips rows whenever the library changes between two requests, and the
   "Show more" pattern a phone needs makes that visible.
3. **The responses become browser-parsed.** Appending a page from the client
   means the two list responses join the seventeen the browser reads through
   `parseResponse` (ADR-0022), with the fixture and stale-tab duties that
   implies.

Options considered for (1): a materialized "effective artist/title" pair of
columns on `library_items` maintained by the confirmation and placement
writes (fast, indexable, but a second copy of the truth that every future
correction path has to remember to update); or evaluating the same
preference in SQL with `coalesce(reviewed_release->>'artist', albums.artist)`
(no new state, no migration, but no index — the planner filters a user's
rows after the `user_id` lookup). Options for (2): offset/limit (simple,
unstable), or keyset continuation on the full sort key (stable, but the
cursor must carry the exact key).

## Decision

**Search, sort and page in SQL over the effective artist/title.** The list
query filters with `ILIKE` (wildcards escaped) and orders on the same
`coalesce(...)` expressions the serializer resolves, so a corrected name is
matched and ordered exactly as it is shown. No materialized column and no
migration: a user's library is small and already filtered by an indexed
`user_id`, so an expression evaluated over those rows is cheap, and the
effective value has one definition rather than two.

**Keyset pagination with a total order.** Each sort names a full key ending
in the row id — `recent`: `(updated_at, id)` descending (favorites:
`(favorited_at, id)`); `artist`: `(lower(artist), lower(title), id)`
ascending; `title`: the same pair the other way round — and a page is `WHERE
key > cursor` (`<` for the descending sort) with `LIMIT n + 1`, the extra row
saying whether a next page exists. The timestamp travels in the cursor at
its full microsecond precision (`to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`)
because a JS `Date` keeps milliseconds and would land a continuation a few
rows early or late whenever rows share one.

**The cursor is opaque, shape-validated, and bound to its sort.** It is
base64url over `{ v: 1, sort, key }`. It is not signed: a caller can only
ever page through their own records, and a tampered cursor either fails to
decode or names a position in the same ordering. A cursor that cannot be read,
carries the wrong number of key parts, or was issued under another sort is
`400 invalid_cursor` (a new `DatabaseCommandError` code mapped at the HTTP
boundary) rather than a silently wrong page.

**Export streams every page.** `GET /library/export` iterates
`iterateLibraryItemsForUser` (pages of 100 under the same list/q/sort) into a
`ReadableStream` of CSV, reading the first page before the response starts so
a database failure is still an error status. It ignores `cursor`/`limit`: an
export is always complete.

**Contract.** `LibraryQuerySchema`/`FavoritesQuerySchema` gain optional
`cursor` (opaque, ≤ 1024 chars) and `limit` (1–100, default 50, coerced from
its query-string text). `GetLibraryResponseSchema`/`GetFavoritesResponseSchema`
gain a required `nextCursor: string | null`. The pages render the first page
server-side and a client "Show more" appends the next through `parseResponse`,
keyed on list/q/sort so a new search starts over. Both responses are now in
`BROWSER_PARSED_RESPONSES` with fixtures; `LibraryQuerySchema` has a
`before-pagination` fixture (list/q/sort only — a bookmarked export link
still works) and a `continuation-page` one. No pre-change response fixture
was frozen: before this change no browser code parsed either response, so
nothing deployed can still read the old shape.

## Consequences

- Search and sort see every record a user has saved, and the export carries
  every match — the roadmap exit ("find/export records beyond a 100-item
  fixture, paginate without duplicates") is proved by integration tests over
  a 120-record account under every sort, including a confirmation whose
  album row was changed underneath it, an insert and an edit between two
  pages of a `recent` walk, and an export iteration crossing a page boundary.
- A record edited while a `recent` walk is in progress moves above the
  cursor and is not seen again on that walk; one edited before it was reached
  is not seen at all. That is inherent to paging on a mutable key and is the
  intended behavior for "most recently changed first"; the name sorts are
  unaffected unless the name itself changes.
- The name sorts order by the database collation's `lower()`, not the
  previous JS `localeCompare(…, { sensitivity: "base" })`; ties now break by
  the other name and then id, so the order is total and identical at any page
  size. Accented characters may sort slightly differently than before.
- `check:contracts` reports one forward incompatibility: a replica still on
  the previous version rejects `cursor`/`limit` with `400 invalid_query`
  during a rolling deploy, so a "Show more" click in that window shows the
  retry message. Reported, not enforced, per ADR-0022: the previous browser
  never sent those parameters.
- No index supports the expression ordering; each page is a filtered scan of
  one user's rows joined to their releases and confirmations. Revisit with a
  materialized effective-name pair (and this ADR superseded) if a library
  grows large enough for that scan to show in P3.5's baseline.
- The dashboard previews ask for `limit: 3` instead of fetching a page and
  slicing it.
