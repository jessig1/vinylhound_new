# Load benchmark (P3.5 Task 2)

Drives the real HTTP API — batch create, scan create, signed upload, real
object-storage PUT, upload completion (readback/validate/normalize), and
submit — against a local production build, with multiple independent
synthetic users and batches per run.

## Why multiple users and batches

`docs/PHASE_3_4_PLAN_REVIEW.md` flagged a specific confound: `enforceScanQuota`
takes `pg_advisory_xact_lock(hashtext(userId))`
(`packages/database/src/scan-repository.ts`) and `createOrGetScan` takes a
`select ... for update` on the batch row. A load test driven by one synthetic
user, or one batch, serializes on those locks and measures the lock rather
than the system. This benchmark always creates `BENCH_USERS` distinct
synthetic users with `BENCH_BATCHES_PER_USER` batches each, generates a fresh
set of random user IDs every run (so quota/active-scan state never carries
over between runs), and shuffles the resulting (user, batch) pairs before
dispatch so concurrent requests land on many independent lock targets.

## Prerequisites

- `docker compose up -d` (PostgreSQL, Redis, MinIO).
- No `OPENAI_API_KEY` needed and none is used: the worker under test is
  `apps/worker/src/e2e-worker.ts`, the same synthetic-identifier worker the
  Playwright e2e suite uses, so this benchmark makes zero billable provider
  calls. Do not point it at a real OpenAI key.
- A `DEVELOPMENT_BENCH_USER_HEADER_ENABLED=true` override lets the benchmark
  address distinct synthetic users over HTTP in `AUTH_MODE=development`
  (see `packages/config/src/index.ts` and `apps/web/src/server/auth.ts`); the
  benchmark sets this itself and it defaults off everywhere else.

## Running it

```
npm run bench:load
```

This is a standalone script (`scripts/` is not an npm workspace), invoked
directly with `tsx`. It:

1. Creates (if missing) and migrates a dedicated `vinylhound_e2e_bench`
   database — isolated from both the developer's own database and the
   Playwright e2e suite's `vinylhound_e2e` database, and truncated at the
   start of every invocation.
2. Builds the web app as a real production standalone server
   (`next build` + the same `prepare-standalone.mjs` assembly
   `apps/web/playwright.config.ts` uses for e2e) into a dedicated
   `.next-bench` dist dir, and starts it on port 3200.
3. Starts `apps/worker/src/e2e-worker.ts` pointed at the same database/queue.
4. Runs one small warmup pass (discarded from all reported metrics) so the
   first timed run isn't paying for cold JIT/connection-pool costs.
5. Runs `BENCH_RUNS` (default 3) timed passes back to back in the same
   long-lived web/worker process ("warm" cache state — no restart between
   runs), each with its own fresh synthetic users.
6. Writes `report.json` and `summary.md` under
   `scripts/benchmark/results/<UTC timestamp>/`, and stops both processes.

### Configuration (environment variables)

| Variable                 | Default | Meaning                               |
| ------------------------ | ------- | ------------------------------------- |
| `BENCH_USERS`            | 5       | distinct synthetic users per run      |
| `BENCH_BATCHES_PER_USER` | 2       | batches created per user              |
| `BENCH_SCANS_PER_BATCH`  | 5       | scan pipelines run per batch          |
| `BENCH_CONCURRENCY`      | 10      | max in-flight scan pipelines          |
| `BENCH_RUNS`             | 3       | timed repetitions (task requires ≥ 3) |

`BENCH_USERS × BENCH_BATCHES_PER_USER × BENCH_SCANS_PER_BATCH` scans run per
timed pass. Keep `BENCH_SCANS_PER_BATCH` at or under `MAX_SCANS_PER_BATCH`
(20, `packages/contracts/src/batch.ts`) and the product of users × batches ×
scans under each synthetic user's `USER_ACTIVE_SCAN_LIMIT` (20 by default) —
the script does not raise quota limits for you.

## What each run measures, and what it does not

Each scan pipeline is `scans.create` → `uploads.create` → `storage.put`
(direct MinIO PUT) → `uploads.complete` (real readback, validate, and
sharp-based normalization) → `scans.submit` (the quota-lock code path).
`report.json`/`summary.md` record p50/p95/p99/min/max/mean per step and for
the full pipeline, throughput, error rate, hardware, the exact git commit,
and whether the working tree was dirty at run time.

This benchmark does not exercise scan confirmation, real AI-adapter latency,
or real OpenAI cost — those are deliberately out of scope here and belong to
P3.5 Tasks 3 and 4 (API percentiles reconciled against `OPERATIONS.md`,
provider-stub versus capped live runs, and single- versus multi-worker
concurrency comparisons).

## Fixture image

`fixture.ts` generates one small synthetic JPEG once (via `sharp`) and reuses
its bytes for every upload in every run. `validateImage`
(`packages/storage/src/image-validation.ts`) requires a real, decodable image
matching its declared checksum/size/type, so a placeholder buffer of random
bytes would fail every upload; only the pipeline's timing is under
measurement here, not image content, so one fixed image is sufficient.
