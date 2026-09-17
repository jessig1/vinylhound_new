# ADR-0024: Copies are inventory, the list is intent; removing the last copy keeps the record owned, and copies can be added by key

- Status: accepted
- Date: 2026-09-12
- Completes: ADR-0010's deferred copy commands; leaves ADR-0011's list rules
  and ADR-0018's removal rule as they are

## Context

ADR-0010 split a saved record (`library_items`, one per user and release)
from the physical copies it owns (`library_copies`, zero or more) and
deferred "copy deletion or editing" to a later slice. That slice shipped as
`PATCH`/`DELETE /library/{itemId}/copies/{copyId}` with ownership checks and
a parent-row lock, and the library item detail page gained a per-copy editor
(2026-09-09). Three things were left open, and roadmap P3.4 Task 2 names
them: what happens when the **last** copy is removed, how a user records a
**second** copy of a release they already own, and proof — tests — that
ownership, idempotency and the confirmation audit trail hold.

The last-copy question is the one with a real choice in it. Every way into
the collection records one copy (a collection confirmation, a `POST
/library` collection placement, a wishlist → collection move, and migration
010's backfill of pre-existing collection rows), so before this decision a
collection record with no copies was unreachable except by removing the last
one — and when a user did that, the page said "No copies are recorded yet.
Moving this record here from your wishlist adds one automatically", which
described a state the record was not in and a way back that did not exist.

Three designs were weighed:

1. **Keep the record in the collection with zero copies.** The list is the
   user's statement ("I own this"); the copies are the inventory behind it.
   Removing inventory does not retract the statement.
2. **Move the record to the wishlist when its last copy goes.** Keeps
   "collection ⇔ at least one copy" as an invariant, but it is a side effect
   the user did not ask for (selling a pressing is not the same as wanting
   the release), and it makes `PATCH /library/{itemId}` with `{ list:
"wishlist" }` a permanently dead path: a collection record would always
   hold a copy, and ADR-0011 rejects the move while any copy exists. That
   is the same smell ADR-0018 removed from `DELETE`.
3. **Refuse to remove the last copy.** Deadlocks with ADR-0011: the user can
   neither remove the last copy nor move the record while it exists, so the
   only exit is deleting the record and its notes, favorite and playlist
   memberships with it.

Second copies have a smaller question: `POST /library` deliberately adds a
copy only when the record has none ("first owned copy"), and `docs/API.md`
already said a second pressing is added "through per-copy editing, where
that intent is explicit" — but no endpoint existed. A copy has no natural
identity, so unlike placement and deletion the request cannot be idempotent
by identity: two blank copies of one record are legitimately distinct.

## Decision

**Copies are inventory; the list is intent.** Design 1:

- Any copy can be removed, the last one included, and removing it never
  changes the record's list. A collection record whose last copy was removed
  stays in the collection with `copyCount: 0`. From there ADR-0011's move to
  the wishlist succeeds (there is nothing left to orphan), a "Move to
  collection" later records a first copy again, and removal is ADR-0018.
  The detail page names the state ("Every copy of this record has been
  removed. It stays in your collection until you move it to your wishlist or
  remove it below; if you still own a copy, add it here."), and the copy
  editor's confirmation for the last copy says what follows before the user
  commits.
- `POST /library/{itemId}/copies` (`CreateLibraryCopySchema`, every field
  optional and null by default) records another copy of a collection record.
  It requires `Idempotency-Key`; the key and a fingerprint of the body are
  stored on the copy it created (migration 017, unique per user), so the same
  key replays to the same copy with `200`, and the same key with a different
  body or for a different record is `conflict`. A wishlist record is
  `invalid_state`; the 101st copy is `library_copy_limit`, enforcing on this
  path the bound (`MAX_LIBRARY_COPIES_PER_ITEM`) that every list response's
  `copies` array already carried without anything enforcing it. The rule
  lives in `packages/domain` (`resolveCopyAddition`) with unit tests.
- Ownership is resolved as the triple `{ userId, itemId, copyId }` under a
  row lock on the parent record: another user's copy, or the caller's own
  copy addressed through a different record, is `not_found` with nothing
  changed. Every copy command moves the record's `updatedAt`.
- Removing a copy leaves its confirmation intact. `scan_confirmations.copy_id`
  has been `on delete set null` since migration 010; this decision makes
  that the documented and tested contract: the scan, release,
  `reviewed_release` snapshot and `confirmed_at` survive, the scan still
  reads as confirmed into the record, and only `libraryItem.copy` becomes
  null.
- Mutation feedback is settled through the router refresh: the copy editor
  reads the `PATCH` response through `parseResponse` and settles its draft on
  what the server kept, a removed copy reads as removed until the refresh
  drops it, and list moves re-enable with a "Moved to your …" status instead
  of staying on "Moving…" until a reload (a defect the Playwright coverage
  for this page found).

## Consequences

- `copyCount: 0` on a collection record is a real state consumers must
  render, not a data error. The grids already showed nothing for one copy
  and a badge for several; the CSV export carries the zero.
- `library_copies` gains two nullable columns that only `POST .../copies`
  fills; copies from confirmations, placements, moves and the backfill carry
  no key because their requests are made idempotent elsewhere.
- "Move to wishlist" remains a two-step action for a record with copies
  (remove them, then move), as ADR-0011 decided and ADR-0018 reaffirmed;
  this decision makes the second step reachable rather than changing the
  rule. A one-step move that deletes copies would need a new decision.
- The cap is not yet enforced where a scan confirmation records a copy
  (ADR-0010: every collection confirmation adds one), so a hundred-and-first
  scan of one release would still make that record's list responses fail to
  serialize. Known, unlikely, and recorded in the handoff rather than solved
  here: refusing a confirmation over a copy count needs its own UX.
- Re-adding a copy after removing the last one produces a new copy id; the
  confirmation's `copy_id` stays null. A confirmation names the copy the
  review created, not whichever copy the user currently holds.
- Rejected alternatives, recorded so they are not re-derived: auto-moving to
  the wishlist (design 2) and refusing the last removal (design 3), for the
  reasons above.
