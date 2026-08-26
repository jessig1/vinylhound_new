# Delivery roadmap

## Milestone 0 — foundation (complete)

- Monorepo, web shell, worker boundary, contracts, domain review policy, AI adapter, local infrastructure, CI, and project documentation.
- Navigable account and library dashboard prototype, using local demo state until persistence and production authentication are implemented.

## Milestone 1 — single-image vertical slice (current)

- [x] Choose database/migration tool and implement user/scan/image/attempt tables.
- [x] Add development identity, signed upload, server validation, and object-storage adapter.
- [x] Add durable enqueue/outbox and queue worker.
- [x] Call the OpenAI adapter, persist candidates/audit metadata, and poll scan status.
- [x] Build mobile capture/upload, result review/correction, and add-to-list UI.
- [x] Add provider-boundary and confirmation integration tests.
- [ ] Establish a small private AI eval baseline.

Exit criterion: one phone photo can become a user-confirmed collection or wishlist item, with retry and failure visibility.

## Milestone 2 — multi-view and batch

- Group front/back/spine/label images per scan.
- Multi-select batch setup, independent item progress, cancellation, and retry.
- Thumbnail/normalization pipeline and worker concurrency limits.
- Batch and provider-cost dashboards.

## Milestone 3 — catalog enrichment and collection quality

- Evaluate a catalog source for canonical IDs, search, deduplication, and pressing detail.
- Add richer collection metadata and duplicate-copy modeling.
- Improve search/filter/export and wishlist-to-owned conversion.

## Milestone 4 — public-ready operations

- Production authentication, account deletion/export, privacy/retention policy.
- Managed infrastructure, backups/restore test, observability, quotas, abuse/spend controls.
- Accessibility and cross-device browser test matrix.

The next recommended task is end-to-end phone-browser coverage for the completed
capture-to-confirm path, followed by a small private AI eval baseline. Avoid
building broad collection features before the path is measurable.
