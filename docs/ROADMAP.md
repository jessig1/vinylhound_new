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

## Milestone 2 — multi-view and batch

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
- [ ] Batch and provider-cost dashboards.

## Milestone 3 — catalog enrichment and collection quality

- Evaluate a catalog source for canonical IDs, search, deduplication, and pressing detail.
- Add richer collection metadata and duplicate-copy modeling.
- Improve search/filter/export and wishlist-to-owned conversion.

## Milestone 4 — public-ready operations

- Production authentication, account deletion/export, privacy/retention policy.
- Managed infrastructure, backups/restore test, observability, quotas, abuse/spend controls.
- Accessibility and cross-device browser test matrix.

The next recommended task is Milestone 2's remaining slice: batch and
provider-cost dashboards. Keep the formal private AI evaluation as a gate
before public rollout or model/cost optimization.
