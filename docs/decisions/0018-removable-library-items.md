# ADR-0018: A saved record can always be removed; its confirmation row survives without it

- Status: accepted
- Date: 2026-09-09
- Supersedes: ADR-0011's `DELETE /library/{itemId}` restriction

## Context

ADR-0011 made `scan_confirmations.library_item_id` a `not null` `restrict`
foreign key and had `deleteLibraryItem` reject any item with confirmation
history, to protect the image-to-result audit trail required by `AGENTS.md`.
That ADR recorded the consequence honestly: "`DELETE` is effectively a no-op
path for real data today," because nearly every library item originates from a
confirmed scan. The `/collection` and `/wishlist` pages therefore hid the
"Remove" action for almost everything.

Reviewing the app as a user made the cost concrete: a record added by mistake,
a wrong AI match confirmed too quickly, or a record sold on could never be
removed. The only escape was deleting the whole account. "Add, edit, delete"
was really "add and edit."

The audit trail argument does not actually require the item to exist. A
confirmation row records _the user's review decision_: which scan, which
release, the `reviewed_release` JSONB snapshot of exactly what they confirmed,
and when. None of that depends on a `library_items` row still being present.
The immutable evidence chain — scan, images, attempts with model and prompt
version, candidates — is in different tables entirely and is untouched by
removing a library item.

## Decision

Migration 012 drops the `not null` on `scan_confirmations.library_item_id` and
changes its foreign key from `on delete restrict` to `on delete set null`.
`deleteLibraryItem` no longer inspects confirmation history: it deletes the
item, its copies cascade, and each confirmation that pointed at it keeps every
audit field while its item reference clears itself. `release_id` stays
`restrict`, since shared catalog rows are never user-deletable.

Three read paths follow from a confirmation that no longer has an item:

- `getScanConfirmationForUser` returns `null`, so the scan reads as
  unconfirmed and its review UI becomes available again. A removed record is
  one the user can save again from the same scan.
- `confirmScan` treats such a row as absent and deletes it before writing the
  new confirmation, rather than raising its usual "already confirmed with
  different data" conflict. Without this, removing a record would permanently
  block re-saving that scan, because `scan_confirmations.scan_id` is the
  primary key and allows only one decision per scan (ADR-0005).
- The account export left-joins instead of inner-joining, and its contract
  makes `libraryItemId` and `list` nullable, so a decision the user made is
  still exported after the record it produced is gone (ADR-0014 promises every
  row the user owns).

The UI always offers "Remove from …" on the library item detail page, behind
an inline confirmation that states the scan is kept.

## Consequences

- Re-confirming a scan whose record was removed replaces the earlier decision
  rather than appending to it, so the _previous_ review decision for that scan
  is lost at that moment. This is the existing one-confirmation-per-scan model
  (ADR-0005), not a new limitation; a future multi-decision history would need
  `scan_confirmations` to stop being keyed solely by `scan_id`.
- `scan_confirmations` can now hold rows whose `library_item_id` is null. Any
  new consumer must handle that case; the three above are the current ones.
- `deleteAccount` still deletes confirmations directly before deleting the
  user. That is no longer strictly required by the item FK, but `release_id`
  remains `restrict` and the explicit delete keeps the ordering obvious.
- ADR-0011's other decisions stand: `PATCH` still covers `list` and `notes`
  only, and collection → wishlist is still rejected while copies exist.
