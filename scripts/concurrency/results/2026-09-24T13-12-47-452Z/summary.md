# P3.5 Task 4 concurrency comparison

Generated 2026-09-24T13:12:47.371Z at commit `df3ea66ce308be6fcc4e4dc7bf42a8c0f4650331` (working tree had uncommitted changes).

Intel(R) Core(TM) 7 150U (12 logical cores), 15.7 GiB RAM, win32/x64, Node v24.18.0. Not a dedicated benchmark machine — an interactive development laptop with other processes running; treat absolute numbers as illustrative and prefer relative comparisons across legs on the same machine.

Fixture: one synthetic 600x600 solid-color JPEG, reused for every upload — real enough to pass validation and reach a real vision call, but not a real album cover, so live-mode token counts/cost are a floor, not a realistic estimate — scripts/benchmark/fixture.ts (shared with the P3.5 Task 2 benchmark)

Every mode/worker-count leg holds **total provider concurrency** constant (`ANALYSIS_CONCURRENCY` split evenly across worker processes) so a throughput difference reflects splitting work across processes, not simply raising the concurrency ceiling.

## Legs

| Mode | Workers | Total concurrency | Per-worker | Scans | Attempts | Throughput (scans/min) | Est. cost |
| ---- | ------- | ----------------- | ---------- | ----- | -------- | ---------------------- | --------- |
| stub | 1       | 2                 | 2          | 25/25 | 25       | 1481.66                | —         |
| stub | 2       | 2                 | 1          | 25/25 | 25       | 1470.29                | —         |
| live | 1       | 2                 | 2          | 5/5   | 5        | 37.19                  | $0.0146   |
| live | 2       | 2                 | 1          | 5/5   | 5        | 42.56                  | $0.0293   |

## Application time vs. provider time, per leg

`storageFetch` is application time (reading the normalized image back from object storage before the provider call); `providerCall` is provider time (the AI adapter round trip); `attempt` is their bundled total, the same value persisted to `scan_attempts.duration_ms`. Milliseconds.

### `stub`, 1 worker(s) @ concurrency 2 each

| Signal                     | n   | min | p50 | p95 | p99 | max | mean |
| -------------------------- | --- | --- | --- | --- | --- | --- | ---- |
| storageFetch (application) | 25  | 4   | 9   | 18  | 43  | 43  | 9.92 |
| providerCall (provider)    | 25  | 0   | 0   | 0   | 0   | 0   | 0    |
| attempt (bundled total)    | 25  | 4   | 9   | 18  | 43  | 43  | 9.96 |

### `stub`, 2 worker(s) @ concurrency 1 each

| Signal                     | n   | min | p50 | p95 | p99 | max | mean  |
| -------------------------- | --- | --- | --- | --- | --- | --- | ----- |
| storageFetch (application) | 25  | 5   | 8   | 48  | 54  | 54  | 11.44 |
| providerCall (provider)    | 25  | 0   | 0   | 0   | 0   | 0   | 0     |
| attempt (bundled total)    | 25  | 5   | 8   | 48  | 54  | 54  | 11.56 |

### `live`, 1 worker(s) @ concurrency 2 each

| Signal                     | n   | min  | p50  | p95  | p99  | max  | mean   |
| -------------------------- | --- | ---- | ---- | ---- | ---- | ---- | ------ |
| storageFetch (application) | 5   | 4    | 8    | 43   | 43   | 43   | 17.8   |
| providerCall (provider)    | 5   | 1827 | 2434 | 2935 | 2935 | 2935 | 2452   |
| attempt (bundled total)    | 5   | 1833 | 2477 | 2943 | 2943 | 2943 | 2469.8 |

### `live`, 2 worker(s) @ concurrency 1 each

| Signal                     | n   | min  | p50  | p95  | p99  | max  | mean   |
| -------------------------- | --- | ---- | ---- | ---- | ---- | ---- | ------ |
| storageFetch (application) | 5   | 6    | 7    | 32   | 32   | 32   | 16.6   |
| providerCall (provider)    | 5   | 1769 | 2004 | 3445 | 3445 | 3445 | 2384   |
| attempt (bundled total)    | 5   | 1776 | 2011 | 3477 | 3477 | 3477 | 2400.6 |
