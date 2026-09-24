# P3.5 Task 2 benchmark results

Generated 2026-09-24T13:09:45.158Z at commit `df3ea66ce308be6fcc4e4dc7bf42a8c0f4650331` (working tree had uncommitted changes).

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

50 scans, 50 ok / 0 failed (error rate 0), wall clock 1804 ms, throughput 27.72 scans/s.

Latencies in milliseconds.

| Step             | n   | min    | p50    | p95    | p99    | max    | mean   |
| ---------------- | --- | ------ | ------ | ------ | ------ | ------ | ------ |
| full pipeline    | 50  | 295.55 | 338.65 | 429.21 | 451.97 | 451.97 | 346.04 |
| scans.create     | 50  | 38.97  | 65.2   | 98.12  | 104.5  | 104.5  | 65.23  |
| uploads.create   | 50  | 35.89  | 57     | 77.15  | 93.32  | 93.32  | 57.31  |
| storage.put      | 50  | 9.36   | 15.28  | 23.07  | 28.53  | 28.53  | 15.52  |
| uploads.complete | 50  | 61.6   | 132.56 | 189.48 | 222.37 | 222.37 | 136.09 |
| scans.submit     | 50  | 25.38  | 70.93  | 102.03 | 110.78 | 110.78 | 71.33  |

### Run 2 — 5 users × 2 batches × 5 scans, concurrency 10

50 scans, 50 ok / 0 failed (error rate 0), wall clock 1619.49 ms, throughput 30.87 scans/s.

Latencies in milliseconds.

| Step             | n   | min    | p50    | p95    | p99    | max    | mean   |
| ---------------- | --- | ------ | ------ | ------ | ------ | ------ | ------ |
| full pipeline    | 50  | 173.05 | 314.48 | 397.91 | 413.34 | 413.34 | 308.12 |
| scans.create     | 50  | 39.09  | 59.16  | 100.68 | 104.98 | 104.98 | 62.73  |
| uploads.create   | 50  | 24.96  | 46.17  | 72.64  | 95.59  | 95.59  | 49.14  |
| storage.put      | 50  | 8.79   | 13.13  | 24.07  | 30.56  | 30.56  | 15.02  |
| uploads.complete | 50  | 48.44  | 117.09 | 168.64 | 170.15 | 170.15 | 120.1  |
| scans.submit     | 50  | 15.7   | 61.33  | 91.7   | 92.79  | 92.79  | 60.53  |

### Run 3 — 5 users × 2 batches × 5 scans, concurrency 10

50 scans, 50 ok / 0 failed (error rate 0), wall clock 1526.8 ms, throughput 32.75 scans/s.

Latencies in milliseconds.

| Step             | n   | min    | p50   | p95    | p99    | max    | mean   |
| ---------------- | --- | ------ | ----- | ------ | ------ | ------ | ------ |
| full pipeline    | 50  | 202.96 | 289.6 | 348.24 | 358.46 | 358.46 | 292.82 |
| scans.create     | 50  | 35.94  | 57.93 | 87.26  | 105.14 | 105.14 | 60.91  |
| uploads.create   | 50  | 31.87  | 47.67 | 64.01  | 68.94  | 68.94  | 48.67  |
| storage.put      | 50  | 9.86   | 14.81 | 28.53  | 32.61  | 32.61  | 15.69  |
| uploads.complete | 50  | 53.41  | 110.9 | 138.6  | 141.16 | 141.16 | 111.7  |
| scans.submit     | 50  | 19.22  | 55.29 | 76.94  | 80.57  | 80.57  | 55.32  |
