# P3.5 Task 3 persisted-attempt reconciliation

Generated 2026-09-18T14:39:31.170Z at commit `8f702dfe5880a5c01481ca7fb61af3c374b5d04b` (working tree had uncommitted changes), against `postgresql://localhost:5432/vinylhound`.

**This reads whatever database the running instance actually used** — a local development database by default, not a load-test fixture. Sample counts, throughput, and queue age reflect real but sparse developer testing cadence (the worker is not continuously running between sessions), not production traffic; treat single-digit or low-double-digit sample counts as illustrative, not statistically reliable percentiles.

## Observed window

2026-08-26T22:03:10.000Z to 2026-09-13T01:43:54.000Z (17.15 days).

## Overall

- **Attempts**: 69
- **Error rate**: 0
- **Throughput**: 4.02 attempts/day (average over the observed window, not a load-test figure)
- **Estimated total AI cost**: $0.2757 (sum of priced attempts only; see per-model breakdown for unpriced counts)

## By model

### `gpt-5.6-terra`

67 attempts, 67 succeeded / 0 failed (error rate 0). 62597 input + 12540 output tokens. Estimated cost: $0.2757.

Queue age (enqueue → worker pickup): 67 of 67 attempts had a matching outbox row still available.
End-to-end latency (enqueue → attempt completion): 67 of 67 attempts.

Milliseconds.

| Signal             | n   | min  | p50  | p95   | p99     | max     | mean     |
| ------------------ | --- | ---- | ---- | ----- | ------- | ------- | -------- |
| attempt duration   | 67  | 932  | 3293 | 16329 | 23327   | 23327   | 5094.22  |
| queue age          | 67  | 0    | 4000 | 16000 | 2559000 | 2559000 | 47134.33 |
| end-to-end latency | 67  | 3000 | 8000 | 27000 | 2563000 | 2563000 | 52283.58 |

### `integration-test-model`

2 attempts, 2 succeeded / 0 failed (error rate 0). 0 input + 0 output tokens. Estimated cost: not priced (no domain pricing entry for this model) (2 attempt(s) excluded — missing token counts or no pricing entry).

Queue age (enqueue → worker pickup): 0 of 2 attempts had a matching outbox row still available.
End-to-end latency (enqueue → attempt completion): 0 of 2 attempts.

Milliseconds.

| Signal             | n   | min | p50 | p95 | p99 | max | mean |
| ------------------ | --- | --- | --- | --- | --- | --- | ---- |
| attempt duration   | 2   | 20  | 20  | 20  | 20  | 20  | 20   |
| queue age          | 0   | 0   | 0   | 0   | 0   | 0   | 0    |
| end-to-end latency | 0   | 0   | 0   | 0   | 0   | 0   | 0    |
