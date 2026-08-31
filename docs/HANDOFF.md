# Session handoff

Live state shared between the agents working in this repository (OpenAI Codex,
primary; Claude, secondary) and the maintainer. Every agent session that
changes files or reaches a decision must update this file before ending. The
sections above the session log describe current state only; history belongs in
the log.

## How to resume

1. Read "Current state" and "Resume point" below.
2. Verify the claimed state cheaply (`git status`, `npm run check`) before
   building on it.
3. Do the work, update this file, and append a session-log entry.

## Current state — verified 2026-08-31

- A reviewer-oriented current-to-target architecture package now lives in
  `docs/architecture/`. It documents the implemented system, including
  MusicBrainz catalog enrichment and physical-copy modeling; labels an AWS
  production deployment as proposed rather than implemented; and defines
  trigger-driven phases for production hardening and post-release scan
  recognition reuse. No runtime or accepted provider decision changed.

- Milestone 1 (single-image vertical slice) is complete. The maintainer accepted
  Sol + `high` + prompt-v2 artist/title quality for the early build; the formal
  private AI eval baseline is deferred until public rollout or model/cost
  optimization (`docs/ROADMAP.md`).
- **Milestone 2 (multi-view and batch) is complete**, all four slices:
  1. Multi-view (`a1ac19d`): front/back/spine/label/barcode/runout photos of
     one physical record group into a single scan and one identification
     request, each image paired with its view label
     (`album-identification.v3`).
  2. Batch (`dd349a1`, ADR-0006): several _distinct_ records captured
     together as one batch, where each photo becomes its own independently
     tracked scan. `POST /batches` creates a grouping shell; `POST /scans`
     accepts an optional `batchId`; `GET /batches/{batchId}` projects each
     member scan's status/top candidate with no persisted batch-level
     state. Retry/cancel, the `/scan` mode toggle, and the
     `/scans/batch/{batchId}` progress page are all part of this slice.
  3. Thumbnail/normalization pipeline (`43de522`, ADR-0007): upload
     completion derives a bounded analysis copy (JPEG, 2048px cap) and a UI
     thumbnail (JPEG, 400px cap) from the validated original, stores both
     as sibling S3 objects (migration 009), and scan analysis reads the
     analysis copy instead of the full-resolution original. Worker
     concurrency limiting (`ANALYSIS_CONCURRENCY`) turned out to already
     exist since Milestone 1; the roadmap note calling it a gap was stale
     and has been corrected.
  4. Batch and provider-cost dashboards (this session, ADR-0008):
     `GET /batches/{batchId}` gained a `cost` field (token totals,
     estimated USD, average duration) aggregated across the batch's member
     scans' attempts, shown on the batch progress page. A new
     `GET /usage` endpoint and `/account/usage` page report the same shape
     account-wide over a rolling 30-day window, plus scan counts by
     outcome. The per-model USD/million-token pricing table moved from the
     private `packages/evals` into `packages/domain`
     (`estimateTokenUsageCostUsd`) so both share one definition; `evals`
     re-exports it unchanged so nothing there broke.
- Codex independently reviewed Milestone 2 and fixed uncovered edge cases:
  the 20-scan batch cap is now enforced transactionally on the server; batch
  scans record `batch_upload`; retrying from an all-terminal batch restarts
  polling; images completed before migration 009 fall back to their original
  object; and versioned Terra/Luna model names use their specific pricing
  instead of the generic Sol-family prefix. The production build also restored
  the generated `next-env.d.ts` imports from `.next/dev` to `.next`.
- Every file chooser shown in Multiple records mode now accepts several images
  in one selection. The explicit upload inputs already supported this; the
  camera inputs now opt into `multiple` in batch mode as well so desktop
  browsers that render `capture` as a normal file dialog do not force
  one-at-a-time selection. One-record camera capture remains single-file.
- Milestone 3 task 1 is complete. `docs/CATALOG_EVALUATION.md` and ADR-0009
  select MusicBrainz as the primary canonical catalog (release group = album,
  release = edition), with Discogs deferred as an optional pressing cross-check
  requiring a fresh terms/attribution/caching review.
- Milestone 3 task 2 is complete. `packages/catalog` provides the catalog port
  and MusicBrainz adapter with a meaningful User-Agent, serialized 1 req/s
  access, 429/503 retry, and 24-hour in-memory cache. The review page exposes a
  user-triggered catalog search and persists selected release-group/release
  MBIDs plus source/fetch provenance. Migration 010 adds richer release fields,
  namespaced `catalog_references`, and `library_copies`; repeated owned
  confirmations reuse one library item but create separate physical copies
  (ADR-0010).
- `npm run check` passes in WSL on Node 22.23.2: formatting, ESLint,
  typecheck, and 53/53 unit tests.
- `npm run build` passes: the Next.js web app (24 routes, including the new
  `/api/v1/catalog/releases` route), worker, and eval package compile cleanly.
- `npm run test:integration` passes in WSL/Docker: database (12), storage (1),
  queue (1), and worker (6) suites, 20/20 total. Confirmation coverage includes
  catalog provenance, wishlist conversion, and two physical copies sharing one
  user/release library item.
- `npm run test:e2e` passes in WSL: 5/5 Playwright tests against a
  production build with the synthetic worker.
- Manually verified `/account/usage` and `/account` in a running dev server
  (WSL, real Postgres data): both render real accumulated data
  (21 scans, $0.45 estimated spend, 83,112 tokens) with no console errors;
  confirmed the mobile bottom nav does not actually clip the last stat row
  (a `fullPage` screenshot made it look clipped, but scrolling to the
  bottom shows `content-page`'s existing 100px bottom padding clears it).
- Docker Compose services (postgres, redis, minio) are running and healthy.
- Milestone 2's original work is committed through `a248eb9`; the subsequent
  audit fixes, MusicBrainz catalog integration, physical-copy model, related
  docs/tests, and the hydration-warning adjustment are committed as `c8f99cd`
  and pushed to `origin/main`.
- The maintainer's private dataset folder contains 52 JPEG cover photos plus a
  draft `manifest.json` and `LABELING_PROMPT.md`. These files remain outside
  the repository and still need app-assisted labels and maintainer verification.
- `packages/evals` provides a private, checkpointed Sol/Terra/Luna comparison
  runner with verified-label/consent gates, per-attempt audit output, aggregate
  quality/routing/latency/token/cost metrics, and non-billable unit coverage.
  Its pricing table now lives in `packages/domain` (ADR-0008) but its
  exported values are unchanged, and it still only ever submits single-image,
  ungrouped cases directly to the provider rather than through the worker's
  image-read path.
- Production album identification defaults to `gpt-5.6-sol` + `high` image
  detail. The ignored local `.env` is synchronized to the Sol default.

## Resume point

<!-- The next session starts here. Replace this section when the task
     completes or is re-scoped. -->

**Task:** Continue Milestone 3 task 3: improve collection/wishlist
search/filter/export and complete the explicit wishlist-to-owned management
flow. The confirmation path already converts wishlist items atomically and now
creates physical copies; general library PATCH/DELETE/copy-management endpoints
remain planned. Keep the private AI matrix deferred until public rollout or
model/cost optimization.

Recently completed, for context:

- Milestone 2 audit and Milestone 3 provider evaluation (2026-08-31): fixed
  server-side batch-size enforcement, correct batch ingestion provenance,
  terminal-batch retry polling, legacy pre-normalization image retries, and
  versioned-model pricing. Selected MusicBrainz over Discogs as the primary
  canonical source and recorded the lookup/deduplication rules and adapter
  requirements in ADR-0009 and `docs/CATALOG_EVALUATION.md`.

- Batch and provider-cost dashboards (this session, ADR-0008,
  `docs/API.md`): shared `UsageCostSummarySchema` in
  `packages/contracts/scan.ts` (attemptCount, input/output/total tokens,
  estimatedCostUsd, averageDurationMs); `GetBatchResponseSchema` gained a
  required `cost` field; new `usage.ts` contract
  (`GetUsageSummaryResponseSchema`, `USAGE_SUMMARY_WINDOW_DAYS = 30`).
  `packages/database/analysis-repository.ts` gained `getBatchCostSummary`
  and `getUsageSummaryForUser`, both selecting `scan_attempts` rows
  filtered to `input_tokens is not null` (a failed attempt that never
  reached the provider has no usage, so it's excluded from cost but still
  counted by outcome) and reducing them in application code via
  `estimateTokenUsageCostUsd` — SQL aggregation was rejected because the
  per-model rate table isn't stored data. New `GET /api/v1/usage/route.ts`
  and `/account/usage/page.tsx` (server component, real data, two
  `settings-card` stat blocks: scan outcomes and provider cost); the batch
  progress page shows a one-line cost/token summary when the batch has any
  priced attempts. `/account` gained a link to the new page. Updated one
  existing contract test (`batch.test.ts`) for the new required field.
- Thumbnail/normalization pipeline (ADR-0007, `docs/API.md`): migration 009
  adds nullable `analysis_size_bytes`/`analysis_width`/`analysis_height`/

- Thumbnail/normalization pipeline (ADR-0007, `docs/API.md`): migration 009
  adds nullable `analysis_size_bytes`/`analysis_width`/`analysis_height`/
  `thumbnail_size_bytes` to `image_assets`, populated together with
  `completed_at` and covered by the same before/after check-constraint
  pattern as `width`/`height`. New `normalizeImage` in `packages/storage`
  (`image-normalization.ts`) derives a JPEG analysis copy (long edge capped
  2048px, quality 82) and thumbnail (long edge capped 400px, quality 70)
  from already-decoded bytes; `ObjectStorage` gained `putObject` for direct
  server-side writes. The upload-complete route (`apps/web/.../uploads/
[imageId]/complete/route.ts`) calls `normalizeImage` on the bytes already
  read for `validateImage`, writes both derived objects under
  `{userId}/{scanId}/{imageId}/analysis` and `.../thumbnail` (new shared
  `deriveImageObjectKey` helper in `packages/database/scan-repository.ts`,
  also now used for the `original` key), and passes their sizes/dimensions to
  `completeImageUpload`. `prepareScanAnalysis`
  (`analysis-repository.ts`) returns the analysis object's key/size/fixed
  `image/jpeg` MIME type instead of the original's; the worker's
  `analysis-handler.ts` needed no change since it already reads whatever
  `prepareScanAnalysis` gives it. Retry and redelivery reuse the stored
  analysis copy rather than re-normalizing. The `CompleteImageUploadResponse`
  contract is unchanged — `width`/`height` still describe the original; no
  client currently reads the new fields since no UI renders scan images yet.
  Investigated the "no worker concurrency limit" known-gap note and found it
  stale: `ANALYSIS_CONCURRENCY` (`packages/config`) has been wired into
  BullMQ's `Worker` `concurrency` option since Milestone 1
  (`8c692ed`, before this session).
- Batch capture (ADR-0006, `docs/API.md`): `batches` table (id, user_id,
  idempotency_key) and nullable `scans.batch_id` (migration 008); new
  `ScanStatusSchema` value `canceled`; `createOrGetBatch`/`getBatchForUser` in
  `packages/database/src/scan-repository.ts`; `listScanSummariesForUser`/
  `listScansForUser` in `analysis-repository.ts` (shared top-candidate
  projection used by both the batch page and scan history). `retryScan` picks
  the next attempt number from `scan_attempts`, replays idempotently by
  returning the latest pending outbox message for an already-`queued`/
  `processing` scan (not a stored request key — see ADR-0006's tradeoff
  note). `cancelScan` is a straightforward terminal-state transition;
  `dispatchNextOutboxMessage` now checks the owning scan's status and marks a
  canceled scan's row published-without-publishing so the poller stops
  retrying it; `prepareScanAnalysis` returns a `"canceled"` result the worker
  treats as a no-op. The `/scan` page's batch mode uploads each photo through
  its own scan/upload/submit cycle in parallel
  (`Promise.allSettled`); a partial failure still routes to the batch page
  with a `?failed=N` banner rather than losing the successfully created scans.
- Two real bugs were caught and fixed by integration tests before commit: an
  off-by-one in `retryScan`'s replay-detection outbox lookup, and a
  cross-test outbox-row leak in the new database integration tests that a
  naive `dispatchNextOutboxMessage` call would pick up (fixed with a
  `dispatchUntil` test helper that drains unrelated rows first). A `.strict()`
  schema mismatch (`GetBatchResponseSchema` rejecting an extra `batchId` key)
  was caught by the e2e suite, not unit/integration tests — worth remembering
  that `.strict()` response schemas need an e2e or route-level check, not just
  a repository-level one.
- Multi-view grouping (prior session): `packages/contracts` gained
  `ImageViewTypeSchema`; `image_assets` gained `view_type` (migration 007);
  `GetScanResponse.images[].viewType`; the OpenAI adapter labels each image
  with `buildAlbumIdentificationContent`; prompt v3.

## Known gaps and risks

- MusicBrainz search has fixture-backed adapter coverage but has not yet been
  exercised against the 20-case metadata acceptance set in
  `docs/CATALOG_EVALUATION.md`. Search remains user-triggered and reviewable;
  there is no automatic enrichment or cover-art fetching.
- No AI eval baseline; broad model/prompt optimization is not yet measurable.
- A historical live check on one byte-identical 4000x3000 cover photo produced
  three materially different Terra outcomes (no candidate, Cherubs / _Heroin
  Man_, and Cows / _Sexy Pee Story_) in 8.1-25.2 seconds. Production now uses
  the maintainer-accepted Sol + `high` + prompt-v2 path, but still uses
  uncropped images (now resized to a 2048px-long-edge analysis copy per
  ADR-0007, previously full resolution) with no catalog retrieval. Multi-view
  sends more images per request, which still raises per-scan token/latency
  cost proportionally to view count even after the resize; a batch of N
  records still means N independent provider calls instead of one. Neither
  is yet measured against the deferred eval baseline, and the resize's actual
  token/cost/quality effect is unmeasured — it followed from the
  known-uncropped/full-resolution gap, not from a benchmark.
- A fresh Linux/WSL machine needs `sudo npx playwright install-deps` once,
  in addition to `npx playwright install chromium`, or Chromium fails to
  launch with a missing-shared-library error (`libnspr4.so` and similar).
- Cancellation is best-effort: a scan canceled while its attempt is already
  `processing` can still complete and show a result, since no in-flight
  OpenAI call is aborted (ADR-0006, accepted tradeoff). A large batch still
  submits all its jobs to BullMQ (and thus the outbox/Redis) at once;
  `ANALYSIS_CONCURRENCY` throttles how many are _processed_ concurrently
  (default 1, max 10) but does not throttle publication itself. This has not
  caused an observed problem and is not currently planned as further work,
  but is worth knowing if a very large batch is ever tested.
- No S3 object cleanup exists for a deleted scan or image: the `original`,
  `analysis`, and `thumbnail` objects are all orphaned in storage when the
  owning row is deleted via the database's cascading foreign key (ADR-0007
  widened this from one orphaned object to three; it did not introduce the
  gap).
- Authentication is the single development user. All rows are user-scoped, so
  swapping in real identity issuance later does not change the data model.
- Library `PATCH`/`DELETE` endpoints are documented as planned, not
  implemented (`docs/API.md`).
- Local-only infrastructure; backups and observability are Milestone 4.
- `GET /usage` and `/account/usage` report a fixed rolling 30-day window
  with no pagination, custom range, or historical trend (ADR-0008,
  deliberate scope cut). `estimatedCostUsd` is `null` whenever no attempt
  in the window used a model present in `packages/domain`'s
  `MODEL_PRICING_USD`, which needs a manual update whenever provider
  pricing changes or a new model is adopted.

## Session log

Newest first. One entry per agent session: date, agent, what changed, what was
decided.

- **2026-08-31 - Codex.** Added a six-page reviewer-oriented architecture
  package under `docs/architecture/`: landing page, current C4-style context/
  container/module/deployment views, scan sequence and state diagrams, current
  ERD and invariants, a proposed AWS production deployment, and a trigger-driven
  current-to-target evolution plan. Reconciled the package with the latest
  Milestone 3 implementation: MusicBrainz remains the accepted canonical
  catalog, while `catalog_references`, `library_copies`, and their provenance/
  ownership boundaries are shown as current. The evolution plan separately
  captures the maintainer's post-release scan-recognition idea: conservative
  non-album filtering, exact and perceptual fingerprint reuse, a versioned
  shared scan-match catalog, AI fallback, and poisoning/privacy controls.
  Updated the root README and `docs/ARCHITECTURE.md` to link the package. The
  AWS view is explicitly a proposal requiring a future ADR; no runtime
  architecture or provider choice changed. Verified Markdown fence balance
  and local package links; application tests were not rerun for this
  documentation-only change.

- **2026-08-31 - Codex.** At the maintainer's request, committed and pushed the
  validated accumulated audit and Milestone 3 tasks 1-2 work as `c8f99cd`
  (`add MusicBrainz catalog integration`), including the existing one-line
  `suppressHydrationWarning` layout adjustment. Refreshed workspace links with
  `npm install`; `npm run check` passes in WSL (53/53 unit tests). The Windows
  Node runtime could not run the check due its restricted home-directory path.

- **2026-08-31 - Codex.** Enabled multi-file selection on the camera/fallback
  file inputs while in Multiple records mode; the dedicated upload inputs
  already supported multi-select. Kept One record camera capture single-file
  and added an e2e assertion covering the formerly missing `multiple`
  attribute. Prettier, focused ESLint, and typecheck pass in WSL/Node 22.23.2;
  the targeted batch-upload Playwright test passes (1/1).

- **2026-08-31 - Codex.** Completed Milestone 3 task 2. Added the catalog port,
  rate-limited/cached/retrying MusicBrainz adapter, review-page catalog search,
  richer release contracts/persistence, namespaced catalog references, and the
  separate physical-copy model (migration 010, ADR-0010). Confirmation remains
  atomic and idempotent: wishlist creates no copy, wishlist-to-owned creates the
  first copy, and a later scan of the same MBID creates another copy beneath the
  same library item. Added contract, adapter, and database integration coverage.
  Verified `npm run check` (53/53 unit tests), `npm run test:integration`
  (20/20), `npm run build` (24 web routes plus worker/evals), and
  `npm run test:e2e` (5/5) in WSL/Node 22.23.2.

- **2026-08-31 - Codex.** Independently reviewed Milestone 2 against the
  roadmap, ADRs, implementation, and full test stack. Confirmed the main four
  slices, then fixed five uncovered edge cases: transactional server enforcement
  of the 20-scan batch cap (with idempotent replay), `batch_upload` provenance,
  polling restart after retrying an all-terminal batch, original-object fallback
  for images completed before migration 009, and longest-prefix pricing for
  versioned Terra/Luna model IDs. Corrected the stale retry state in
  `docs/DOMAIN.md`, restored production `next-env.d.ts` imports via the build,
  and ignored local `.claude` settings so checks are reproducible. Completed
  Milestone 3 task 1 by comparing current official MusicBrainz and Discogs
  documentation, selecting MusicBrainz in ADR-0009, and documenting lookup,
  deduplication, rate-limit, licensing, provenance, and adapter acceptance
  requirements. Verified WSL/Node 22.23.2: `npm run check` (49/49 unit tests),
  `npm run test:integration` (20/20), `npm run test:e2e` (5/5), and
  `npm run build`. Changes are uncommitted. A concurrent
  `apps/web/src/app/layout.tsx` edit was preserved and not reviewed as part of
  this work.

- **2026-08-30 - Claude (fourth session).** Committed and pushed the prior
  session's thumbnail/normalization work (`43de522`, on top of already-pushed
  `a1ac19d`/`dd349a1`) at the maintainer's request, then implemented
  Milestone 2's last remaining slice, batch and provider-cost dashboards
  (ADR-0008), completing Milestone 2. Moved the per-model USD/million-token
  pricing table and cost formula from the private `packages/evals` into
  `packages/domain` (`provider-pricing.ts`) so both the eval harness and
  production share one definition; `evals` now re-exports the domain values
  instead of duplicating them, verified unbroken via its own unit tests and
  package build. Added `getBatchCostSummary` and `getUsageSummaryForUser` to
  `packages/database`, a shared `UsageCostSummarySchema` and new `usage.ts`
  contract, a `cost` field on `GetBatchResponse`, a new `GET /api/v1/usage`
  route, and a new `/account/usage` page. Updated the batch progress page to
  show a cost/token summary line and added a link from `/account`. Fixed one
  existing contract test that needed the new required `cost` field. Verified
  in WSL/Node 22.23.2: 48/48 unit tests, lint, typecheck, build (23 routes,
  +2), 18/18 integration tests (10 database, +1 new covering cost
  aggregation), and 5/5 e2e tests; one worker-suite run hit a transient,
  pre-existing Postgres deadlock unrelated to this session's changes and
  passed cleanly on re-run. Manually launched the app in a WSL dev server
  and screenshotted both new/changed pages against real accumulated
  database data to confirm they render correctly (see "Current state").
  Updated `docs/API.md`, `docs/TESTING.md`, `docs/ROADMAP.md` (Milestone 2
  now marked complete; next task points at Milestone 3), and this file.
  Batch/dashboard work is uncommitted; the maintainer should review before
  commit.
- **2026-08-30 - Claude (third session).** Implemented Milestone 2's third
  slice, the thumbnail/normalization pipeline (ADR-0007): migration 009
  (`image_assets` analysis/thumbnail size and dimension columns, a
  before/after check constraint), a new `normalizeImage` in
  `packages/storage` (bounded JPEG analysis copy and thumbnail derived from
  already-decoded upload bytes), a new `ObjectStorage.putObject` for direct
  server-side writes, a shared `deriveImageObjectKey` helper in
  `packages/database`, upload-completion route changes to generate and store
  both derived objects, and a `prepareScanAnalysis` change so scan analysis
  reads the analysis copy instead of the full-resolution original (no worker
  code changed — it already reads whatever object key it's given). Also
  investigated and corrected a stale known-gap claim: worker concurrency
  limiting (`ANALYSIS_CONCURRENCY`) already existed since Milestone 1 and
  needed no new work; only the thumbnail/normalization half of the roadmap
  line was actually outstanding. Updated 5 existing `completeImageUpload`
  call sites across two integration test files to supply the new required
  fields, and fixed one integration test's storage stub whose fixed 3-byte
  stub response no longer matched the fixture's `analysisSizeBytes`. Added
  new unit coverage for `normalizeImage`'s size bounds. Verified in WSL/Node
  22.23.2 against the running Docker services: 48/48 unit tests
  (2 new), lint, typecheck, build (21 routes), 17/17 integration tests
  (migration 009 applied), and 5/5 e2e tests (which now exercise the real
  normalization pipeline against MinIO on every upload). Updated
  `docs/API.md`, `docs/TESTING.md`, `docs/ROADMAP.md`, and this file.
  Nothing committed or pushed; the maintainer should review before commit.
- **2026-08-30 - Claude (second session).** Implemented Milestone 2's batch
  slice end to end: contracts (`batch.ts`, `canceled` status, `RetryScanResponse`/
  `CancelScanResponse`/`ListScansResponse`), migration 008 (`batches` table,
  `scans.batch_id`, `canceled` enum value), repository functions
  (`createOrGetBatch`, `getBatchForUser`, `retryScan`, `cancelScan`,
  `listScanSummariesForUser`, `listScansForUser`), an outbox/worker change so
  a canceled scan's job is skipped rather than dispatched or analyzed, five
  new API routes, a `/scan` mode toggle for batch capture, a new
  `/scans/batch/{batchId}` progress page with per-item cancel/retry, and a
  real-data rewrite of `/scans`. Wrote ADR-0006 recording the batch-as-
  grouping and best-effort-cancellation design. Found and fixed two real bugs
  via integration tests before they could ship (see "Recently completed"
  above for detail) and one `.strict()` schema mismatch via the e2e suite.
  Verified in WSL/Node 22.23.2: 46/46 unit tests, lint, typecheck, build
  (21 routes), 17/17 integration tests, and 5/5 e2e tests, including a new
  batch e2e scenario. Updated `docs/API.md`, `docs/TESTING.md`,
  `docs/ROADMAP.md`, and this file. Nothing committed or pushed; the
  maintainer should review before commit.
- **2026-08-30 - Claude.** Resumed the Milestone 2 multi-view slice that Codex
  had left uncommitted (no handoff entry for it). Reviewed the full diff
  (contracts, schema/migration 007, repositories, AI adapter/prompt v3,
  worker, `/scan` UI, tests) end to end before continuing; found it complete
  and coherent, so finished it rather than restarting. Fixed Prettier
  formatting on 4 files flagged by `npm run check`. Verified in WSL/Node
  22.23.2 against the running Docker services: 39/39 unit tests, lint,
  typecheck, and build all pass; applied migration 007 and ran
  `npm run test:integration` (13/13, including a new multi-view worker test).
  Installed Playwright Chromium and its OS dependencies
  (`playwright install-deps`, with the maintainer running the sudo step), then
  added and passed a new e2e scenario grouping front/back/spine photos into
  one labeled scan (4/4 e2e tests). Updated `docs/API.md` with the `viewType`
  field, `docs/TESTING.md` with the new e2e coverage and the WSL
  `install-deps` requirement, and `docs/ROADMAP.md` to check off the
  completed slice and point the next resume at Milestone 2's batch slice. No
  ADR added: this extends the existing AI-identification request/response
  contract (ADR-0002) rather than changing a service boundary or provider.
  Nothing committed or pushed; the maintainer should review before commit.
- **2026-08-29 - Codex.** Closed Milestone 1 at the maintainer's direction after
  the Sol + `high` + prompt-v2 flow proved good enough for the early build. The
  formal private AI baseline is explicitly deferred until public rollout or
  model/cost optimization, and the resume point now begins Milestone 2 with
  multi-view scans.
- **2026-08-29 - Codex.** Simplified production album identification around the
  maintainer's actual goal. Changed the default and ignored local configuration
  from Terra to Sol while retaining `high` detail, introduced artist/title-first
  prompt v2, prevented missing pressing/edition evidence from being requested as
  an album-level review reason, added focused tests, and reframed the formal eval
  harness as optional until public rollout or optimization. `npm run check`
  (35/35 tests) and `npm run build` pass in WSL/Node 22. No live OpenAI calls
  were made.
- **2026-08-29 - Codex.** Implemented the requested Sol/Terra × high/auto
  experiment. Added multi-detail CLI execution, model/detail-keyed attempts and
  aggregates, schema-v2 checkpoints, a dedicated `eval:ai:vision-matrix`
  command, matrix unit coverage, and five documented test iterations. The real
  manifest dry-run reaches the readiness gate but has no development cases yet.
  `npm run check` (32/32 tests) and `npm run build` pass in WSL; no billable API
  calls were made.
- **2026-08-29 - Codex.** Diagnosed reported image-analysis quality and latency
  without changing runtime behavior. The database audit confirmed three
  byte-identical uploads produced unstable Terra results and 8.1-25.2 second
  durations. Identified likely contributors: single-image UI, `detail: high`
  downsampling, conservative edition-aware prompt/review routing, no image
  preprocessing, no catalog retrieval, and no completed eval baseline.
- **2026-08-29 - Codex.** Repaired the local WSL worker connection without
  deleting data: rotated the development PostgreSQL role, synchronized the
  ignored `.env`, and changed only `DATABASE_URL` to use
  `host.docker.internal` because WSL's `localhost:5432` reaches a separate
  PostgreSQL server. Docker PostgreSQL authentication and the normal WSL
  migration command were verified; the schema is current.
- **2026-08-29 - Codex.** Implemented `packages/evals`, a private live-model
  comparison CLI defaulting to GPT-5.6 Sol/Terra/Luna. Added strict manifest,
  consent, and maintainer-verification gates; request-by-request checkpoints;
  rank-1/top-3, edition, routing, schema/error, latency, token, and estimated-cost
  metrics; three test files; and `docs/EVALUATION.md`. Formatting, ESLint,
  typecheck, the eval package build, and 31/31 unit tests pass via direct Node
  entry points. No billable API calls were made; Node 22+ and completed private
  labels are still required for the baseline.
- **2026-08-29 - Codex.** Created a private 52-case single-image evaluation
  manifest and labeling prompt beside the maintainer's album photos. The
  manifest separates ChatGPT/Gemini suggestions from maintainer-verified ground
  truth and remains outside Git. No application code changed.

- **2026-08-29 — Codex.** Read-only project-state evaluation. Verified a
  clean working tree, `npm run check` (22/22 tests), and `npm run build`.
  Docker Desktop is stopped, so integration and e2e tests were not rerun.
  Corrected the stale claim that no browser e2e suite exists and recorded that
  `main` is two commits ahead of `origin/main`.
- **2026-08-26 — Claude (fifth session).** Confirmed the full pipeline works
  with real analysis. Built the phone-sized Playwright e2e suite (3 tests,
  passing): isolated production server, e2e database/queue, synthetic worker.
  Updated `docs/TESTING.md` and `docs/ROADMAP.md`; only the AI eval baseline
  remains in Milestone 1. `npm run check` and `npm run build` pass.
- **2026-08-26 — Claude (fourth session).** Investigated a post-fix 422 on
  the same `.webp` file. Proved via database checksums and a live end-to-end
  reproduction (`tmp/diagnose-upload.mjs`) that the server pipeline is
  correct for all WebP variants and the retry ran the stale pre-fix browser
  bundle. Removed the diagnostic scans and objects. No code changed.
- **2026-08-26 — Claude (third session).** Committed the vertical slice
  (`8c692ed`). Fixed the upload rejection: added magic-byte sniffing to
  `packages/contracts` with tests, switched the scan page to declare the
  sniffed MIME type, and noted the client behavior in `docs/API.md`.
  `npm run check` (22 tests) and `npm run build` pass. Nothing pushed.
- **2026-08-26 — Claude (second session).** Recorded the in-flight WebP
  upload-rejection investigation as the resume point, with an independent
  read-only evaluation of the likely cause (extension-derived `File.type`
  versus server magic-byte sniff). No application code changed.
- **2026-08-26 — Claude.** Evaluated project state; verified `npm run check`
  and `npm run build` pass. Created `CLAUDE.md` and this handoff file; linked
  both from `AGENTS.md`. No application code changed.
