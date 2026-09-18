# P3.5 Task 4 concurrency comparison

Generated 2026-09-18T16:22:43.519Z at commit `445addcb3c4c0c0a6d207c3d76c19a952bcc1d12` (working tree had uncommitted changes).

Intel(R) Core(TM) 7 150U (12 logical cores), 15.7 GiB RAM, win32/x64, Node v24.18.0. Not a dedicated benchmark machine — an interactive development laptop with other processes running; treat absolute numbers as illustrative and prefer relative comparisons across legs on the same machine.

Fixture: one synthetic 600x600 solid-color JPEG, reused for every upload — real enough to pass validation and reach a real vision call, but not a real album cover, so live-mode token counts/cost are a floor, not a realistic estimate — scripts/benchmark/fixture.ts (shared with the P3.5 Task 2 benchmark)

Every mode/worker-count leg holds **total provider concurrency** constant (`ANALYSIS_CONCURRENCY` split evenly across worker processes) so a throughput difference reflects splitting work across processes, not simply raising the concurrency ceiling.

## Legs

| Mode | Workers | Total concurrency | Per-worker | Scans | Attempts | Throughput (scans/min) | Est. cost |
| ---- | ------- | ----------------- | ---------- | ----- | -------- | ---------------------- | --------- |
| stub | 1       | 2                 | 2          | 25/25 | 25       | 1498.2                 | —         |
| stub | 2       | 2                 | 1          | 25/25 | 25       | 1489.04                | —         |
| live | 1       | 2                 | 2          | 5/5   | 5        | 27.06                  | $0.0148   |
| live | 2       | 2                 | 1          | 5/5   | 5        | 22.84                  | $0.015    |

## Application time vs. provider time, per leg

`storageFetch` is application time (reading the normalized image back from object storage before the provider call); `providerCall` is provider time (the AI adapter round trip); `attempt` is their bundled total, the same value persisted to `scan_attempts.duration_ms`. Milliseconds.

### `stub`, 1 worker(s) @ concurrency 2 each

| Signal                     | n   | min | p50 | p95 | p99 | max | mean |
| -------------------------- | --- | --- | --- | --- | --- | --- | ---- |
| storageFetch (application) | 25  | 3   | 6   | 12  | 28  | 28  | 7.28 |
| providerCall (provider)    | 25  | 0   | 0   | 0   | 1   | 1   | 0.04 |
| attempt (bundled total)    | 25  | 3   | 6   | 12  | 28  | 28  | 7.32 |

### `stub`, 2 worker(s) @ concurrency 1 each

| Signal                     | n   | min | p50 | p95 | p99 | max | mean |
| -------------------------- | --- | --- | --- | --- | --- | --- | ---- |
| storageFetch (application) | 25  | 3   | 6   | 30  | 32  | 32  | 7.92 |
| providerCall (provider)    | 25  | 0   | 0   | 0   | 0   | 0   | 0    |
| attempt (bundled total)    | 25  | 3   | 6   | 30  | 32  | 32  | 7.92 |

### `live`, 1 worker(s) @ concurrency 2 each

| Signal                     | n   | min  | p50  | p95  | p99  | max  | mean   |
| -------------------------- | --- | ---- | ---- | ---- | ---- | ---- | ------ |
| storageFetch (application) | 5   | 4    | 5    | 33   | 33   | 33   | 10.6   |
| providerCall (provider)    | 5   | 2186 | 3188 | 4464 | 4464 | 4464 | 3388.2 |
| attempt (bundled total)    | 5   | 2190 | 3193 | 4497 | 4497 | 4497 | 3398.8 |

### `live`, 2 worker(s) @ concurrency 1 each

| Signal                     | n   | min  | p50  | p95  | p99  | max  | mean   |
| -------------------------- | --- | ---- | ---- | ---- | ---- | ---- | ------ |
| storageFetch (application) | 5   | 4    | 4    | 24   | 24   | 24   | 11.8   |
| providerCall (provider)    | 5   | 2613 | 3103 | 5882 | 5882 | 5882 | 4019.2 |
| attempt (bundled total)    | 5   | 2617 | 3127 | 5905 | 5905 | 5905 | 4031   |
