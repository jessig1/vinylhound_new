# ADR-0006: Batches group independent scans; cancellation does not interrupt in-flight work

- Status: accepted
- Date: 2026-08-30

## Context

Milestone 2's second slice lets a user capture several distinct physical
records in one sitting, with independent per-item progress, cancellation, and
retry. The first Milestone 2 slice (multi-view) already groups several photos
of the _same_ record into one scan and one identification request. Batching
needed a grouping concept for _different_ records without disturbing that
existing single-scan pipeline, its audit trail, or its review policy.

Two designs were considered for grouping:

1. A `batch` as a first-class job unit, with its own attempt/result rows and
   a single job fanned out to per-item sub-jobs.
2. A `batch` as a thin grouping row over ordinary, independently submitted
   scans, each keeping its existing one-scan-one-attempt lifecycle.

Cancellation also needed a concrete meaning. A queued BullMQ job dispatches
quickly and an in-flight OpenAI call cannot be interrupted mid-request, so
"cancel" cannot mean pre-empting active provider work without either wasting
a paid call anyway or adding distributed cancellation signaling.

## Decision

A `batches` table stores only `id`, `user_id`, `idempotency_key`, and
`created_at`. `scans.batch_id` is a nullable foreign key. Each photo in a
batch becomes its own ordinary scan, submitted, queued, and analyzed through
the unchanged single-scan pipeline; the batch is a read-side grouping, not a
new job or attempt concept. `GET /batches/{batchId}` projects each member
scan's status and top candidate; no batch-level status is persisted, only
computed.

Cancellation adds one terminal `scan_status` value, `canceled`. Canceling a
scan that has not yet been dispatched marks its outbox row published without
publishing it, so the poller skips it for good. Canceling a scan whose
analysis is already `processing` still lets that attempt finish and persist a
result — the cancellation only prevents _future_ attempts (no retry is
offered afterward unless the user starts a new scan). No in-flight OpenAI
call is aborted.

`POST /scans/{scanId}/retry` reuses the scan's already-uploaded, completed
images and creates attempt N+1 through the same outbox/worker path as the
original submission. It is restricted to `failed` and `unresolved` scans;
`needs_review` already has a human-actionable result and is handled by
confirmation, not retry.

## Consequences

- Multi-view and batch capture share one identification pipeline, one review
  policy, and one audit trail; nothing about Milestone 1's guarantees changed
  for either mode.
- A batch has no independent failure mode of its own to test or reason
  about — batch integration tests reduce to "N independent scans linked by
  one foreign key," which is what the test suite exercises.
- Cancellation is best-effort and can occasionally still show a result for an
  item the user canceled, if the provider call was already in flight when the
  cancel request landed. This was an explicit, accepted tradeoff over adding
  cross-process cancellation signaling for a rare race.
- The outbox dispatcher now does one extra lookup (the owning scan's status)
  per message before publishing; at current volume this is not a measurable
  cost, and it keeps the "never call the provider for a canceled scan" rule
  enforced in one place rather than scattered across the worker.
- Retry's idempotency relies on scan-state transitions (a scan already
  `queued`/`processing` returns its existing pending job) rather than a
  stored per-request idempotency key column, unlike submit and confirm. This
  keeps the schema smaller at the cost of being slightly less precise about
  exact-request replay; a second retry call with a different key still safely
  returns the one pending attempt rather than erroring or double-queuing.
