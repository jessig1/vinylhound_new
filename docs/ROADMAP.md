# Delivery roadmap

## Milestone 0 — foundation (complete)

- Monorepo, web shell, worker boundary, contracts, domain review policy, AI adapter, local infrastructure, CI, and project documentation.
- Navigable account and library dashboard prototype, using local demo state until persistence and production authentication are implemented.

## Milestone 1 — single-image vertical slice (complete)

- [x] Choose database/migration tool and implement user/scan/image/attempt tables.
- [x] Add development identity, signed upload, server validation, and object-storage adapter.
- [x] Add durable enqueue/outbox and queue worker.
- [x] Call the OpenAI adapter, persist candidates/audit metadata, and poll scan status.
- [x] Build mobile capture/upload, result review/correction, and add-to-list UI.
- [x] Add provider-boundary and confirmation integration tests.
- [x] Add phone-sized end-to-end coverage for the capture-to-confirm path.
- [x] Validate Sol + `high` + prompt v2 manually and accept its artist/title
      quality for the early build. The formal private AI evaluation is deferred
      until public rollout or model/cost optimization.

Exit criterion: one phone photo can become a user-confirmed collection or wishlist item, with retry and failure visibility.

## Milestone 2 — multi-view and batch (complete)

- [x] Group front/back/spine/label images per scan, sent as one labeled
      identification request; preserves the single-image flow and audit trail.
- [x] Multi-select batch setup, independent item progress, cancellation, and
      retry (ADR-0006). Each photo in a batch becomes its own independently
      tracked scan; the `/scan` page gains a "One record" / "Multiple
      records" mode toggle, and `/scans/batch/{batchId}` shows per-item
      status with cancel/retry actions. `/scans` now lists real persisted
      scan history instead of demo data.
- [x] Thumbnail/normalization pipeline (ADR-0007): upload completion derives a
      bounded analysis copy and a UI thumbnail from the validated original;
      scan analysis reads the analysis copy instead of the full-resolution
      original. Worker concurrency limits (`ANALYSIS_CONCURRENCY`, wired into
      BullMQ's `Worker` `concurrency` option) already existed since
      Milestone 1; the roadmap note describing them as missing was stale.
- [x] Batch and provider-cost dashboards: `GET /batches/{batchId}` now
      returns a `cost` summary (tokens and estimated USD) aggregated across
      the batch's member scans, shown on the batch progress page. A new
      `GET /usage` endpoint and `/account/usage` page report account-wide
      scan outcomes and estimated provider spend/token usage over a rolling
      30-day window. Pricing lives in `packages/domain` (moved from the
      private eval package so both share one table).

## Milestone 3 — catalog enrichment and collection quality

- [x] Evaluate catalog sources for canonical IDs, search, deduplication, and
      pressing detail. MusicBrainz is the primary catalog; Discogs is deferred
      as an optional pressing cross-check (ADR-0009 and
      `docs/CATALOG_EVALUATION.md`).
- [x] Add the catalog port/MusicBrainz adapter, richer release metadata, and
      duplicate-copy modeling.
- [x] Direct wishlist-to-owned (and back) conversion without a rescan:
      `PATCH`/`DELETE /library/{itemId}` (ADR-0011), with collection/wishlist
      page actions. Per-copy edit/delete remains explicitly deferred.
- [x] Library search, sort, and CSV export (ADR-0012): `GET /library` accepts
      `q`/`sort` (recent/artist/title), matching and sorting the same
      effective artist/title the page renders; `GET /library/export` returns
      the same filtered/sorted list as a CSV download. Both apply after the
      existing 100-item fetch, so search narrows within that page rather than
      searching beyond it — no pagination was added.

Milestone 3 is complete except per-copy condition/location/notes/acquisition-date
edit and delete (ADR-0010, ADR-0011), which remains explicitly deferred to a
future slice.

## Milestone 4 — public-ready operations

- Production authentication, account deletion/export, privacy/retention policy.
- Managed infrastructure, backups/restore test, observability, quotas, abuse/spend controls.
- Accessibility and cross-device browser test matrix.

Milestone 2 and Milestone 3 are complete except per-copy edit/delete, which
remains explicitly deferred to a future slice (not currently the next
recommended task — see `docs/HANDOFF.md`'s resume point for what to pick up
next). Keep the formal private AI evaluation as a gate before public rollout
or model/cost optimization.
