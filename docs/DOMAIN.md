# Domain model

## Important distinction

An `Album` is the artistic work (artist + title). A `Release` is a published edition. A `Copy` is a physical item owned by a user. Cover recognition may identify the album without proving the release or copy details. The UI and data model must preserve that uncertainty.

## Entities

| Entity      | Purpose                                     | Important fields                                                             |
| ----------- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| User        | Owner/security boundary                     | id, created_at                                                               |
| ScanBatch   | Groups a batch submission                   | id, user_id, source, counts, created_at                                      |
| Scan        | One logical record identification           | id, batch_id?, user_id, status, idempotency_key                              |
| ImageAsset  | One stored image and its integrity metadata | id, scan_id, object_key, MIME, bytes, checksum, view_type?                   |
| ScanAttempt | Append-only provider delivery/audit record  | scan_id, logical attempt, delivery, model, prompt, response ID, usage, error |
| Candidate   | A normalized AI/catalog candidate           | artist, title, release facts, confidence, evidence, rank                     |
| Album       | Canonical artistic work                     | id, normalized artist/title                                                  |
| Release     | A particular edition when known             | id, album_id, year, label, catalog number, barcode, country                  |
| Copy        | A physical owned copy                       | id, release_id, condition/location/notes (post-MVP)                          |
| LibraryItem | User intent for a release                   | user_id, release_id, list, notes, confirmed_from_scan_id                     |

## Invariants

- A scan belongs to exactly one user and has at least one completed image before it can be queued.
- Scan state changes follow the documented state machine; terminal states never silently revert.
- Provider confidence is advisory. Domain policy owns the review decision.
- Candidates are immutable for a successful provider delivery. Queue retries append a delivery audit row under the same logical scan attempt; explicit user retries create a new logical attempt.
- Only a user-confirmed candidate/correction may create a library item.
- A user cannot have duplicate wishlist entries for the same release.
- Adding an owned item for a wished-for release should remove or convert the wishlist entry transactionally.
- Object keys are opaque and scoped to a user/scan; public URLs are never persisted as identifiers.

For the first vertical slice, one library item represents a user's relationship
to a release. Confirmation creates that item atomically. A later copy model can
permit multiple owned physical copies without weakening wishlist uniqueness.

## Scan state machine

```text
awaiting_upload -> queued -> processing -> identified
                                  |       -> needs_review
                                  |       -> unresolved
                                  -> failed

failed/unresolved/needs_review -> queued (explicit retry)
```

`identified` means the system has a high-confidence candidate ready for confirmation. It does not mean the user owns it or that the precise pressing is verified.

## Normalization

Keep original display strings. Store separate normalized keys for matching (case folding, whitespace/punctuation normalization, Unicode normalization), and do not erase artist qualifiers or edition text from displayed values. External catalog IDs should be namespaced by provider.
