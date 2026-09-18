# Persisted-attempt reconciliation (P3.5 Task 3)

Computes attempt duration, queue age, end-to-end latency, error rate,
throughput, and estimated AI cost directly from real persisted
`scan_attempts`/`outbox_messages` rows — the "reuse persisted attempts"
half of P3.5 Task 3. It never touches the database; it only reads.

## Why a script instead of one-off SQL

The same reconciliation needs to run again after more real usage
accumulates, and potentially against a different environment's database (a
bastion/port-forward to staging or production, once one exists). A committed
script makes that reproducible the same way `scripts/benchmark/` made the
Task 2 load benchmark reproducible, rather than leaving the method only in a
session's terminal history.

## Running it

```
npm run metrics:reconcile
```

Reads `DATABASE_URL` from `.env` (or the environment) like any other
`vinylhound` command — **there is no isolation here on purpose**: this reads
whatever database the running application actually used, by default the
developer's own local one. It is a plain read-only query; nothing is created,
truncated, or migrated.

Writes `report.json` and `summary.md` under
`scripts/metrics/results/<UTC timestamp>/`.

## What it computes, and from where

`scan_attempts` records `started_at` (worker pickup) and `duration_ms`
(bundled provider-call + storage-fetch time), but never when its job was
enqueued. `outbox_messages` does — `created_at` — for the same
`(scan_id, attempt_number)` pair, as long as that row hasn't since been
reaped. Joining the two gives, per attempt:

- **attempt duration** — `scan_attempts.duration_ms` directly.
- **queue age** — `started_at − outbox.created_at` (enqueue to worker
  pickup).
- **end-to-end latency** — `completed_at − outbox.created_at` (enqueue to
  attempt completion).
- **error rate** — the fraction of attempts with `status = 'failed'`.
- **throughput** — attempt count over the observed `started_at` span, in
  attempts/day. On a database with sparse manual testing rather than
  continuous production traffic, this measures testing cadence, not system
  capacity — read it as such, not as a load-test figure (that's
  `scripts/benchmark/`'s job).
- **estimated AI cost** — `@vinylhound/domain`'s `estimateTokenUsageCostUsd`,
  the same pricing function the `/usage` endpoint and batch cost summaries
  use, applied to every attempt's real `input_tokens`/`output_tokens`
  regardless of how far back it happened (the `/usage` endpoint itself is
  fixed to a rolling 30-day window at the contract level). An attempt whose
  model has no entry in `packages/domain/src/provider-pricing.ts` (e.g. a
  test-only model name) is counted and reported separately, never silently
  dropped from the attempt/error-rate totals — only excluded from the cost
  sum.

Grouped by model, since a database can carry a mix of real provider attempts
and synthetic/test-only ones (an `integration-test-model` row, for instance,
has no cost entry and no matching outbox row by design) and averaging them
together would misrepresent both.

## What this does not cover

API request p50/p95, error rate, and upload/normalization phase timing live
only in structured logs (`[web] http_request` → now
`{"event":"http_request",...}`, `[web] upload_complete_timing`), not in a
table — those are queried with CloudWatch Logs Insights instead, documented
alongside the persisted-attempt numbers in `docs/OPERATIONS.md`'s "Reconciled
performance and cost signals (P3.5 Task 3)" section. Provider-stub versus a
small capped live run, and held-concurrency worker comparisons, are Task 4.
