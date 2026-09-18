# P3.5 Task 2 benchmark results

Generated 2026-09-17T21:07:11.871Z at commit `1f5602cca389e200fb94655d0e15bb89fcb1109e` (working tree had uncommitted changes).

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

50 scans, 50 ok / 0 failed (error rate 0), wall clock 1792.72 ms, throughput 27.89 scans/s.

Latencies in milliseconds.

| Step             | n   | min    | p50    | p95    | p99    | max    | mean   |
| ---------------- | --- | ------ | ------ | ------ | ------ | ------ | ------ |
| full pipeline    | 50  | 222.47 | 362.55 | 415.61 | 431.65 | 431.65 | 345.69 |
| scans.create     | 50  | 39.38  | 60.56  | 94.48  | 117.32 | 117.32 | 63.04  |
| uploads.create   | 50  | 32.12  | 55.18  | 98.54  | 119.15 | 119.15 | 60.13  |
| storage.put      | 50  | 10.99  | 15.6   | 21.71  | 26.81  | 26.81  | 15.89  |
| uploads.complete | 50  | 58.99  | 136.75 | 178.58 | 182.39 | 182.39 | 137.98 |
| scans.submit     | 50  | 21.66  | 66.95  | 101.81 | 130.39 | 130.39 | 68.08  |

### Run 2 — 5 users × 2 batches × 5 scans, concurrency 10

50 scans, 50 ok / 0 failed (error rate 0), wall clock 1672.89 ms, throughput 29.89 scans/s.

Latencies in milliseconds.

| Step             | n   | min    | p50    | p95    | p99    | max    | mean   |
| ---------------- | --- | ------ | ------ | ------ | ------ | ------ | ------ |
| full pipeline    | 50  | 280.56 | 320.01 | 359.6  | 375.12 | 375.12 | 322    |
| scans.create     | 50  | 34.12  | 53.4   | 76.32  | 113.3  | 113.3  | 56.45  |
| uploads.create   | 50  | 41.75  | 53.58  | 71.44  | 76.3   | 76.3   | 54.39  |
| storage.put      | 50  | 8.9    | 14.61  | 22.61  | 29.97  | 29.97  | 15.23  |
| uploads.complete | 50  | 70.75  | 133.4  | 164.04 | 182.94 | 182.94 | 132.69 |
| scans.submit     | 50  | 25.67  | 59.06  | 95.68  | 107.32 | 107.32 | 62.72  |

### Run 3 — 5 users × 2 batches × 5 scans, concurrency 10

50 scans, 50 ok / 0 failed (error rate 0), wall clock 1674.98 ms, throughput 29.85 scans/s.

Latencies in milliseconds.

| Step             | n   | min    | p50    | p95    | p99    | max    | mean   |
| ---------------- | --- | ------ | ------ | ------ | ------ | ------ | ------ |
| full pipeline    | 50  | 179.55 | 322.09 | 380.01 | 400.05 | 400.05 | 319.98 |
| scans.create     | 50  | 37.92  | 59.54  | 105.28 | 122.39 | 122.39 | 64.45  |
| uploads.create   | 50  | 26.36  | 52.12  | 91     | 95.25  | 95.25  | 55.45  |
| storage.put      | 50  | 8.65   | 14.97  | 25.87  | 29.09  | 29.09  | 15.44  |
| uploads.complete | 50  | 56.02  | 125.91 | 159.15 | 167.96 | 167.96 | 122.93 |
| scans.submit     | 50  | 20.18  | 60.62  | 91.99  | 126.94 | 126.94 | 61.17  |
