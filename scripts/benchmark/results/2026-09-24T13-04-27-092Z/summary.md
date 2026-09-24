# P3.5 Task 2 benchmark results

Generated 2026-09-24T13:04:26.998Z at commit `df3ea66ce308be6fcc4e4dc7bf42a8c0f4650331` (working tree had uncommitted changes).

## Hardware / tier

Intel(R) Core(TM) 7 150U (12 logical cores), 15.7 GiB RAM, win32/x64, Node v24.18.0. Not a dedicated benchmark machine — an interactive development laptop with other processes running; treat absolute numbers as illustrative and prefer relative comparisons across runs on the same machine.

## Target

- **mode**: local production standalone build (next build, single web replica, single worker replica)
- **database**: dedicated local PostgreSQL (docker compose), migrated fresh
- **queue**: dedicated local Redis/BullMQ queue
- **objectStorage**: local MinIO (real presigned S3-compatible PUT round trip)
- **aiAdapter**: synthetic (apps/worker/src/e2e-worker.ts); no OpenAI calls, no provider spend

## Dataset

- 5 distinct synthetic users, 2 batches per user, 5 scans per batch (50 scans/run). Fresh random user IDs every run, so pg_advisory_xact_lock(hashtext(userId)) in enforceScanQuota and the batch row SELECT ... FOR UPDATE in createOrGetScan are both exercised across many independent lock targets rather than one, and no quota state carries over between runs (see docs/PHASE_3_4_PLAN_REVIEW.md).
- Image: one synthetic 600x600 JPEG, reused for every upload

## Cache state and warmup

- single long-lived web + worker process for the warmup pass and all timed runs below (warm DB/Redis/MinIO connection pools and JIT); no restart between runs
- Warmup: 2 users × 1 batches × 3 scans. run once immediately after the stack reports ready; discarded from all reported metrics

## Runs

### Run 1 — 5 users × 2 batches × 5 scans, concurrency 10

50 scans, 50 ok / 0 failed (error rate 0), wall clock 1808.92 ms, throughput 27.64 scans/s.

Latencies in milliseconds.

| Step | n | min | p50 | p95 | p99 | max | mean |
| --- | --- | --- | --- | --- | --- | --- | --- |
| full pipeline | 50 | 163.75 | 339.22 | 483.32 | 507.17 | 507.17 | 347.66 |
| scans.create | 50 | 50.24 | 70.44 | 113.88 | 119.43 | 119.43 | 72.34 |
| uploads.create | 50 | 27.23 | 56.82 | 86.67 | 96.9 | 96.9 | 58.1 |
| storage.put | 50 | 8.96 | 15.25 | 38.3 | 70.77 | 70.77 | 18.61 |
| uploads.complete | 50 | 49.28 | 121.85 | 212.87 | 227.11 | 227.11 | 128.14 |
| scans.submit | 50 | 15.29 | 73.39 | 94.13 | 99.75 | 99.75 | 69.9 |

### Run 2 — 5 users × 2 batches × 5 scans, concurrency 10

50 scans, 50 ok / 0 failed (error rate 0), wall clock 1669.3 ms, throughput 29.95 scans/s.

Latencies in milliseconds.

| Step | n | min | p50 | p95 | p99 | max | mean |
| --- | --- | --- | --- | --- | --- | --- | --- |
| full pipeline | 50 | 261.65 | 305.56 | 367.55 | 376.78 | 376.78 | 312.75 |
| scans.create | 50 | 34.26 | 60.3 | 93.11 | 120.87 | 120.87 | 62.9 |
| uploads.create | 50 | 33.61 | 48.21 | 65.19 | 73.42 | 73.42 | 49.3 |
| storage.put | 50 | 9.37 | 13.66 | 25.17 | 49.04 | 49.04 | 15.42 |
| uploads.complete | 50 | 49.23 | 115.46 | 173.34 | 203.05 | 203.05 | 120.39 |
| scans.submit | 50 | 30.6 | 60.11 | 106.49 | 119.66 | 119.66 | 64.25 |

### Run 3 — 5 users × 2 batches × 5 scans, concurrency 10

50 scans, 50 ok / 0 failed (error rate 0), wall clock 1762.9 ms, throughput 28.36 scans/s.

Latencies in milliseconds.

| Step | n | min | p50 | p95 | p99 | max | mean |
| --- | --- | --- | --- | --- | --- | --- | --- |
| full pipeline | 50 | 257.2 | 337.41 | 405.67 | 469.81 | 469.81 | 336.54 |
| scans.create | 50 | 38.62 | 60.56 | 84.16 | 107.72 | 107.72 | 61.94 |
| uploads.create | 50 | 31.04 | 50.29 | 89.64 | 120.85 | 120.85 | 55.27 |
| storage.put | 50 | 9.59 | 14.52 | 23.09 | 24.48 | 24.48 | 15.05 |
| uploads.complete | 50 | 63.59 | 147.33 | 172.98 | 189.5 | 189.5 | 137.2 |
| scans.submit | 50 | 21.93 | 63.3 | 104.8 | 126.55 | 126.55 | 66.57 |
