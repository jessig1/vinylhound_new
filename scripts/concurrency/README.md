# Concurrency comparison (P3.5 Task 4)

Compares the deterministic provider stub against a small capped real OpenAI
run, and compares one worker process against several — holding **total
provider concurrency constant** across the worker-count comparison, per the
roadmap task's explicit requirement — while separating application time from
provider time for every attempt.

## Why a separate tool from `scripts/benchmark/`

`scripts/benchmark/` (P3.5 Task 2) measures the HTTP submission pipeline
only: it returns as soon as `POST .../submit` responds `202`, before the
worker has picked the job up at all. This tool measures the other half —
actual analysis completion — and needs two things that benchmark doesn't:
starting a variable number of real worker processes with a controlled
`ANALYSIS_CONCURRENCY` split, and (for `mode=live`) a real `OPENAI_API_KEY`.
Reuses benchmark's `stats.ts`, `client.ts`, and `fixture.ts` directly rather
than duplicating them.

## Modes

- **`stub`** — `apps/worker/src/e2e-worker.ts`, the same deterministic,
  zero-cost synthetic identifier the Playwright e2e suite and the Task 2
  benchmark use. Free, fast, safe to run repeatedly.
- **`live`** — the real `apps/worker/src/index.ts`, calling the real OpenAI
  adapter with whatever `OPENAI_API_KEY`/`OPENAI_VISION_MODEL`/
  `OPENAI_IMAGE_DETAIL` your own `.env` already has. **This makes real,
  billable API calls.** Refuses to start with a clear error if
  `OPENAI_API_KEY` is empty, rather than silently falling back to the stub.

Both modes run through the exact same `apps/worker/src/analysis-handler.ts`
code path, so `storageFetchDurationMs` (application time — reading the
normalized image back from storage) and `providerCallDurationMs` (provider
time — the AI adapter round trip) are directly comparable between them: the
stub's provider time is near-zero by construction, so its numbers isolate
pure application overhead, and subtracting that from a live leg's numbers is
a reasonable estimate of real provider latency alone.

## Holding total provider concurrency constant

`docs/PHASE_3_4_PLAN_REVIEW.md`-style confounds apply here too: comparing
"1 worker" against "2 workers" without controlling for concurrency would
really be comparing "2 total in-flight provider calls" against "4 total
in-flight provider calls" — a different variable entirely.
`CONCURRENCY_TOTAL` (default 4) is split evenly across `CONCURRENCY_WORKER_COUNTS`
(default `1,2`) via each worker process's `ANALYSIS_CONCURRENCY`, so every
leg has the same total ceiling on concurrent provider calls regardless of
how many processes it's spread across.

## Running it

```
# Free — deterministic stub only (the default)
npm run concurrency:compare

# Makes real, billable OpenAI calls — see the hard cap below
CONCURRENCY_MODES=live npm run concurrency:compare

# Both, back to back
CONCURRENCY_MODES=stub,live npm run concurrency:compare
```

### Configuration (environment variables)

| Variable                          | Default           | Meaning                                                                                                                                                                                       |
| --------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONCURRENCY_MODES`               | `stub`            | comma list of `stub`/`live` to run, in order                                                                                                                                                  |
| `CONCURRENCY_WORKER_COUNTS`       | `1,2`             | comma list of worker-process counts to compare                                                                                                                                                |
| `CONCURRENCY_TOTAL`               | `2`               | total provider concurrency, split evenly across each leg's workers (must divide evenly by every value in `CONCURRENCY_WORKER_COUNTS`)                                                         |
| `CONCURRENCY_STUB_SCANS`          | `15`              | scans submitted per stub leg (free — raise this freely)                                                                                                                                       |
| `CONCURRENCY_LIVE_SCANS`          | `5`               | scans submitted per **live** leg                                                                                                                                                              |
| `CONCURRENCY_LIVE_HARD_CAP`       | `20`              | refuses to start if `CONCURRENCY_LIVE_SCANS × (worker-count legs) × (live is in CONCURRENCY_MODES ? 1 : 0)` would exceed this — a deliberate brake against an accidental large real-money run |
| `CONCURRENCY_ANALYSIS_TIMEOUT_MS` | `600000` (10 min) | how long to wait for a leg's scans to finish analysis before failing                                                                                                                          |

Each scan uses the same synthetic 600×600 solid-color JPEG
`scripts/benchmark/fixture.ts` generates — real enough to pass validation and
reach a real vision call, but not a real album cover. **Live-mode token
counts and cost are a floor, not a realistic estimate**: a real photographed
cover is visually more complex and will generally cost more per call than
this fixture does. This tool measures latency/concurrency mechanics, not
identification quality or realistic per-scan cost — that's `packages/evals`'
job, on consented private images.

## What each leg measures, and what it does not

Per leg: distinct scans completed, attempt count (may exceed scan count if a
real call transiently failed and retried — every attempt is still reported,
not just the terminal one), throughput (scans/minute), and
`storageFetchDurationMs`/`providerCallDurationMs`/`durationMs` percentiles
captured live from each worker process's own `scan_analysis_timing` stdout
line (now single-line JSON as of P3.5 Task 3 — this tool would not have been
this simple to build before that fix). Live legs additionally report
estimated cost, read directly from the leg's own isolated
`scan_attempts` rows after each leg (the database is truncated between
legs, so no leg's attempts can contaminate another's cost total) using the
same `estimateTokenUsageCostUsd` pricing function `/usage` and
`scripts/metrics/reconcile.ts` both already use.

This does not cover the HTTP submission pipeline itself (that's
`scripts/benchmark/`'s job), and does not evaluate identification accuracy
or quality (that's `packages/evals`' job, per P4.5).

## Isolation

A dedicated `vinylhound_e2e_concurrency` database, `vinylhound-scans-concurrency`
BullMQ queue, and port 3300 — separate from both the developer's own stack
and `scripts/benchmark/`'s `vinylhound_e2e_bench`/3200, so the two tools
never collide even if run back to back.
