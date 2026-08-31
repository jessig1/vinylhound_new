# ADR-0011: Direct library management stays list/notes only; confirmed items cannot be hard-deleted

- Status: accepted
- Date: 2026-08-31

## Context

`docs/API.md` documented `PATCH`/`DELETE /library/{itemId}` as planned since
Milestone 1, and ADR-0010 explicitly deferred copy editing/deletion to "the
next library management slice." Until now the only way to move a wishlist
item to owned, or vice versa, was re-running the atomic scan-confirmation
command (`confirmScan`), which requires a new scan.

Two design questions needed resolving: how much of the copy-level detail
(condition, location, notes, acquisition date) `PATCH` should cover in this
slice, and what a `DELETE` should do given that `scan_confirmations` has a
`not null` foreign key to `library_items` with `onDelete: "restrict"` — a
deliberate constraint protecting the image-to-result audit trail
(`AGENTS.md`). Nearly every library item created through the normal app flow
has at least one confirmation row, so a naive `DELETE` would surface a raw
Postgres foreign-key violation on most real items rather than a usable error.

## Decision

`UpdateLibraryItemSchema` covers `list` and `notes` only; per-copy condition/
location/notes/acquisition-date editing remains a separate future slice
(ADR-0010 already flagged this split). `PATCH /library/{itemId}` enforces:

- Wishlist → collection creates one blank copy if the item has none yet,
  matching `confirmScan`'s existing "first owned copy" rule.
- Collection → wishlist is rejected with `invalid_state` whenever the item
  still has any copies, so a copy is never silently orphaned or deleted as a
  side effect of a list change.

`DELETE /library/{itemId}` checks for existing `scan_confirmations` rows
before deleting and rejects with `invalid_state` if any exist, rather than
letting the database's `restrict` constraint surface as an opaque 500. In
practice this means a library item with confirmation history — the normal
case — cannot be hard-deleted yet; only a hypothetically directly-added item
with no confirmations can be. The `/collection` and `/wishlist` pages hide
the "Remove" action whenever `confirmedFromScanId` is set, so the UI never
offers a destructive action group that the server would reject.

## Consequences

- `DELETE` is effectively a no-op path for real data today. A future slice
  that wants confirmed items to be removable will need an explicit decision
  about what happens to their `scan_confirmations` audit rows (e.g. an
  archived/soft-deleted state) rather than a hard delete.
- Per-copy edit/delete endpoints remain planned, matching ADR-0010's
  consequences section; `copies` on `LibraryItemResult` stays read/insert-only
  from this slice's endpoints.
- `updateLibraryItem` and `deleteLibraryItem` both take a row lock
  (`for("update")`) on the target `library_items` row before checking
  invariants, following `confirmScan`'s existing pattern for guarding
  concurrent mutation of the same item.
