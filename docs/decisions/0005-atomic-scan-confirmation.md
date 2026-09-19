# ADR-0005: Atomic scan confirmation and list placement

- Status: accepted; superseded by
  [ADR-0028](0028-async-scan-confirmation.md) (2026-09-19)
- Date: 2026-08-26

> **Superseded.** The "one PostgreSQL transaction" design below — a single
> transaction spanning `scan_confirmations`, `library_items`, and
> `library_copies` — was replaced by ADR-0028 (P4.2 Task 3): `confirmScan`
> now records only the reviewed confirmation and a versioned event in its own
> transaction; a separate "core" consumer resolves the release and writes the
> library rows; a third transaction projects completion back onto
> `scan_confirmations`. The product-level guarantees this ADR states (no
> stranded list update, converts wishlist to owned, never downgrades, and the
> narrower-than-general-library-management scope) still hold — ADR-0028
> changes how they are delivered, not what they promise.

## Context

The first review UI must let a user select or correct an identification and add
the reviewed release to collection or wishlist. Separate confirmation and list
commands create a failure window where a scan is confirmed but the intended
library change is lost. The product also requires replay-safe mutations and must
not treat an AI candidate as verified until a person confirms it.

## Decision

Use one idempotent `POST /api/v1/scans/{scanId}/confirm` command for the initial
vertical slice. The request contains the selected candidate ID when applicable,
the user-reviewed release fields, and the target list. One PostgreSQL transaction
records the confirmation, creates or reuses normalized album/release rows, and
creates or converts the user's library item.

Only scans in `identified`, `needs_review`, or `unresolved` may be confirmed. A
selected candidate must belong to the latest successful attempt for that scan.
The stored confirmation retains the candidate link and a request fingerprint so
safe idempotent replays can be distinguished from conflicting reuse. It also
stores the exact reviewed release payload separately from the reusable canonical
release, preserving user corrections and display strings in the audit trail.

## Consequences

- The capture-to-confirm flow cannot strand a list update between API calls.
- Manual corrections and unresolved scans use the same auditable command.
- Adding an owned release converts an existing wishlist entry; adding a wishlist
  entry never downgrades an existing owned entry.
- This command is deliberately narrower than general library management. Later
  library endpoints can move, annotate, and remove items independently.
