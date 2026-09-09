# ADR-0017: Dismissing a scan result reuses `cancelScan`; the dashboard acts on scans directly

- Status: accepted
- Date: 2026-09-09

## Context

The dashboard's "Latest scans" section already lists individual scans, not
batches — `listScansForUser`/`listScanSummariesForUser` project one row per
scan, and a batch is only ever a grouping several such rows share (ADR-0006).
The maintainer asked for two things on that same section: confirm each scan
shows up individually (already true), and let a user add a scan's top
candidate to their collection/wishlist or dismiss the result without leaving
the dashboard.

Two design questions needed resolving: what "dismiss" means for a scan that
already has a reviewable result, and whether the dashboard needed a new,
separate read/write surface to support inline actions.

`cancelScan` (`packages/database/src/scan-repository.ts`) already existed for
stopping an active scan (`awaiting_upload`/`queued`/`processing` →
`canceled`), and every scan detail page already treats `canceled` as "no
result was saved, nothing further to do here." A dismissed result is the same
outcome reached from a different starting state: the user saw the candidate
and chose not to keep it, rather than the scan being interrupted before it
finished. Introducing a second terminal status (e.g. `dismissed`) would mean
duplicating that handling across the scan detail page, the batch review page,
and every place that renders a status badge, for a distinction the product
does not otherwise need.

## Decision

`cancelScan` now also accepts `identified`, `needs_review`, `unresolved`, and
`failed` as valid pre-states, transitioning them to `canceled` exactly like
the existing active-state path — same idempotent replay behavior, same `200`
response shape. It rejects with `invalid_state` if the scan already has a
`scan_confirmations` row, so a saved result can never be silently discarded.
No new status value, contract, or endpoint was added; `POST
/scans/{scanId}/cancel` is the single "this scan is done, one way or
another" action. The dashboard labels this action "Dismiss" and, only on that
page, renders `canceled` as "Dismissed" rather than "Canceled" — a
presentation choice local to `apps/web/src/app/dashboard/scan-activity-row.tsx`,
not a renamed status.

`listScanSummariesForUser` now also returns `confirmedList` (`"collection" |
"wishlist" | null`), read from `scan_confirmations` joined to `library_items`
in one batched query across the requested scan IDs rather than one query per
scan. This is what lets the dashboard decide, per row, whether to show
add/dismiss actions, an "Added to your collection/wishlist" line, or neither
— the alternative was letting the client re-derive that from `status` alone,
which cannot distinguish a scan whose result was kept from one still sitting
unactioned.

The dashboard's `/dashboard` server component is unchanged in shape: it still
calls `listScansForUser` directly (not through the JSON `GET /scans` route,
which this change does not touch) and passes the three most recent summaries
to a new client component, `ScanActivityRow`. That component calls the
existing `POST /scans/{scanId}/confirm` and `POST /scans/{scanId}/cancel`
routes — the same ones the scan detail and batch review pages already use —
and calls `router.refresh()` on success rather than tracking optimistic local
state, so the row's next render reflects the real server state (including
`confirmedList`) instead of a client-guessed one.

## Consequences

- `canceled` now means two different things depending on which state a scan
  was in beforehand ("stopped before finishing" vs. "reviewed and
  discarded"), and the database does not record which. If a future need
  arises to distinguish them (e.g. separate analytics, or wording that must
  differ outside the dashboard), that requires either a new column or
  inferring it from whether `scan_attempts`/`scan_candidates` rows exist for
  the scan — not a decision this ADR makes.
- The dashboard is now the only page that relabels `canceled` as "Dismissed";
  `/scans`, the scan detail page, and the batch review page still say
  "Canceled" for the same underlying status. This is an accepted, deliberate
  inconsistency scoped to where the action was framed as "dismiss."
- `GET /scans` (`apps/web/src/app/api/v1/scans/route.ts`) and its
  `ScanListItemSchema`/`ListScansResponseSchema` contract were not touched by
  this change and do not carry `confirmedList` or `thumbnailImageId`, even
  though `listScanSummariesForUser` (which that route also calls) now returns
  both. That route already has a pre-existing `.strict()` mismatch unrelated
  to this work — see `docs/HANDOFF.md`.
