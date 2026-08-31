# ADR-0008: Aggregate provider cost/token usage from stored attempts, in application code

- Status: accepted
- Date: 2026-08-30

## Context

Every `scan_attempts` row already records `input_tokens`/`output_tokens`/
`total_tokens`/`duration_ms` per attempt (Milestone 1), but nothing
aggregated them into a batch-level or account-level view. `packages/evals`
already estimated USD cost per attempt for its private live-model comparison
reports, using a per-model USD/million-token pricing table
(`MODEL_PRICING_USD`) and a small `estimateAttemptCost` formula, but that
package is a private, opt-in evaluation harness (`AGENTS.md`'s architectural
boundaries) — `apps/web` should not depend on it for production behavior.

Two questions needed resolving: where the pricing table should live so both
the private eval harness and the production dashboards can use one
definition, and whether to compute per-model cost in SQL or in application
code.

## Decision

The pricing table and cost formula moved to `packages/domain`
(`provider-pricing.ts`, `estimateTokenUsageCostUsd`), since `packages/domain`
already holds provider-independent business rules with no framework or
process-boundary dependencies, and `packages/evals` already depended on it.
`packages/evals/src/metrics.ts` now re-exports `MODEL_PRICING_USD`/
`MODEL_PRICING_AS_OF` from `packages/domain` instead of defining its own copy,
so eval reports and production dashboards can never drift on pricing.

Aggregation happens in application code, not SQL: `packages/database`'s
`getBatchCostSummary` and `getUsageSummaryForUser` (`analysis-repository.ts`)
select the relevant `scan_attempts` rows (filtered to `input_tokens is not
null`, since a failed attempt that never reached the provider has no usage to
price) and call `estimateTokenUsageCostUsd` per row in TypeScript, because the
per-model rate table is not stored data — computing it in SQL would mean
either duplicating the pricing table as a `CASE` expression or a lookup
table migration, both harder to keep in sync with `packages/domain` than one
shared function.

`GET /batches/{batchId}` gained a `cost` field on its existing response
(token totals, estimated USD, average duration) computed from that batch's
member scans' attempts. A new `GET /usage` endpoint and `/account/usage`
page report the same shape account-wide over a rolling 30-day window
(`USAGE_SUMMARY_WINDOW_DAYS`), alongside scan counts by outcome
(identified/needs_review/unresolved/failed/canceled/in-progress).

## Consequences

- `estimatedCostUsd` is `null` whenever no attempt in the window used a
  model present in `MODEL_PRICING_USD` (e.g. an unpriced/new model string),
  matching the eval harness's existing behavior of reporting cost as
  unavailable rather than silently zero.
- The usage window is fixed at 30 days with no pagination or historical
  trend view; a user auditing spend over a longer or custom window has no
  way to do so from the UI yet. This is a deliberate scope cut, not an
  oversight — the roadmap line asked for a dashboard, not a full billing
  history.
- Aggregation queries fetch per-attempt rows and reduce them in memory
  rather than using SQL `SUM`, which is adequate at current data volume but
  would need revisiting (either a materialized rollup or pushing the
  pricing table into SQL) if a user's attempt history grows large enough to
  make row-by-row transfer and reduction a measurable cost.
- No caching: both endpoints recompute their aggregate on every request,
  consistent with the rest of the app's server-rendered, `force-dynamic`
  pages.
