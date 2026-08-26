# ADR-0005: Atomic scan confirmation and list placement

- Status: accepted
- Date: 2026-08-26

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
