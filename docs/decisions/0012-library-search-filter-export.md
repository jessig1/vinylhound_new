# ADR-0012: Library search/sort/export match the displayed release, not the stored album row

- Status: accepted; the "after the 100-row fetch" tradeoff is superseded by
  [ADR-0023](0023-full-library-search-and-keyset-pagination.md), which moves
  the same effective-release matching and ordering into SQL and pages it
- Date: 2026-08-31

## Context

`docs/ROADMAP.md` listed "improve search/filter/export" as the remaining half
of Milestone 3 task 3 (the wishlist-to-owned half shipped in ADR-0011). The
collection/wishlist pages already had a non-functional search box and sort
button as UI placeholders.

The displayed artist/title for a library item is not always `albums.artist`/
`albums.title`: when the item was created through scan confirmation,
`GET /library` prefers the corrected values in `scan_confirmations.
reviewed_release` (a JSONB column) over the shared, deduplicated album row
(`library-repository.ts`'s existing `attachCopiesAndSerialize`). A user who
corrected a misidentified artist name expects search and sort to follow the
name they see and confirmed, not the original album row two other users'
copies might still share.

## Decision

`filterLibraryItemsByQuery` and the artist/title sort both operate on the
already-serialized `LibraryItemResult[]` — the same effective artist/title the
UI renders — rather than pushing a `WHERE`/`ORDER BY` into the SQL query
against `albums`/`releases`. This is consistent with the existing serialization
step, which already resolves the displayed release the same way. The list
query keeps its existing 100-row cap and unchanged SQL shape; filtering and
sorting happen in application code after that fetch.

`GET /library` gained optional `q` (trimmed, max 200 chars) and `sort`
(`recent` | `artist` | `title`, default `recent`) query parameters, validated
together with `list` by a new `LibraryQuerySchema`. A new `GET /library/export`
route reuses the same query shape and repository call, and serializes the
result as `text/csv` with a `content-disposition: attachment` header instead
of JSON.

## Consequences

- Correct against manual corrections: a corrected artist name is searchable
  and sortable immediately, with no dependency on `albums`/`releases`
  eventually being updated or re-deduplicated.
- Filtering happens after the existing 100-row fetch, not before it — a
  search only ever narrows within the same page of results, it does not (yet)
  paginate past the cap. This is acceptable at current data volume, matching
  the same tradeoff already accepted for cost/usage aggregation (ADR-0008),
  but would need revisiting (either a real SQL `ILIKE` filter accepting the
  edge-case staleness, or a materialized "effective" column) if a user's
  library ever approaches the 100-item cap.
- CSV export does not stream; it builds the full string in memory. Fine at
  current/expected personal-collection scale, not appropriate if list size
  limits are ever raised significantly.
- No pagination was added to `GET /library` itself; export and search both
  inherit the existing 100-row limit rather than introducing a new one.
