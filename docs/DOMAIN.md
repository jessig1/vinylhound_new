# Domain model

## Important distinction

An `Album` is the artistic work (artist + title). A `Release` is a published edition. A `Copy` is a physical item owned by a user. Cover recognition may identify the album without proving the release or copy details. The UI and data model must preserve that uncertainty.

## Entities

| Entity        | Purpose                                     | Important fields                                                             |
| ------------- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| User          | Owner/security boundary                     | id, created_at                                                               |
| ScanBatch     | Groups a batch submission                   | id, user_id, source, counts, created_at                                      |
| Scan          | One logical record identification           | id, batch_id?, user_id, status, idempotency_key                              |
| ImageAsset    | One stored image and its integrity metadata | id, scan_id, object_key, MIME, bytes, checksum, view_type?                   |
| ScanAttempt   | Append-only provider delivery/audit record  | scan_id, logical attempt, delivery, model, prompt, response ID, usage, error |
| Candidate     | A normalized AI/catalog candidate           | artist, title, release facts, confidence, evidence, rank                     |
| Album         | Canonical artistic work                     | id, normalized artist/title                                                  |
| Release       | A particular edition when known             | id, album_id, year, label, catalog number, barcode, country                  |
| Copy          | A physical owned copy                       | id, user_id, release_id, condition, location, notes, acquired_at             |
| LibraryItem   | User intent for a release                   | user_id, release_id, list, notes, confirmed_from_scan_id, favorited_at       |
| Playlist      | A user-owned ordered list of saved records  | id, user_id, name (unique per user, normalized)                              |
| PlaylistEntry | One saved record's place in a playlist      | playlist_id, library_item_id, position                                       |

## Invariants

- A scan belongs to exactly one user and has at least one completed image before it can be queued.
- Scan state changes follow the documented state machine; terminal states never silently revert.
- Provider confidence is advisory. Domain policy owns the review decision.
- Candidates are immutable for a successful provider delivery. Queue retries append a delivery audit row under the same logical scan attempt; explicit user retries create a new logical attempt.
- Only a user-confirmed candidate/correction may create a library item.
- A user cannot have duplicate wishlist entries for the same release.
- A collection library item may own multiple physical copies of its release;
  a wishlist item owns none.
- Adding an owned item for a wished-for release should remove or convert the wishlist entry transactionally.
- Object keys are opaque and scoped to a user/scan; public URLs are never persisted as identifiers.
- A favorite is an attribute of a library item, not a third list: a record in
  either list can be one, nothing unsaved can be, and removing the record
  removes the favorite. Re-favoriting keeps the original `favorited_at`.
- A playlist entry references one of the owner's own library items — a saved
  release — never a bare release or a catalog result. A playlist holds each
  saved release at most once; removing the saved record removes its entries
  from every playlist. Playlists organize music and never play it.
- Playlist order is by `position`, unique per playlist and ascending but not
  necessarily contiguous. A reorder must name every current entry exactly
  once and is rejected whole when it does not, so concurrent editors cannot
  silently drop each other's entries (ADR-0021).

One library item represents a user's relationship to a release. Each
collection confirmation creates a separate physical copy beneath that item,
while repeated scans reuse the relationship. Wishlist confirmation creates no
copy, preserving one wishlist entry per user/release.

## Scan state machine

```text
awaiting_upload -> queued -> processing -> identified
                                  |       -> needs_review
                                  |       -> unresolved
                                  -> failed

failed/unresolved -> queued (explicit retry)
```

`identified` means the system has a high-confidence candidate ready for confirmation. It does not mean the user owns it or that the precise pressing is verified.

## Normalization

Keep original display strings. Store separate normalized keys for matching (case folding, whitespace/punctuation normalization, Unicode normalization), and do not erase artist qualifiers or edition text from displayed values. External catalog IDs should be namespaced by provider.
