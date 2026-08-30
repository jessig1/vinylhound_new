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

## Current state — verified 2026-08-30

- Milestone 1 (single-image vertical slice) is complete. The maintainer accepted
  Sol + `high` + prompt-v2 artist/title quality for the early build; the formal
  private AI eval baseline is deferred until public rollout or model/cost
  optimization (`docs/ROADMAP.md`).
- Milestone 2's first slice (multi-view) is complete: front/back/spine/label/
  barcode/runout photos of one physical record can be grouped into a single
  scan and sent to the identifier as one request, each image paired with its
  view label (`album-identification.v3`).
- Milestone 2's second slice (batch) is complete (ADR-0006): several
  _distinct_ records can be captured together as one batch, where each photo
  becomes its own independently tracked scan. `POST /batches` creates a
  grouping shell; `POST /scans` accepts an optional `batchId`; `GET
/batches/{batchId}` projects each member scan's status/top candidate with
  no persisted batch-level state. `POST /scans/{scanId}/retry` (new attempt
  from `failed`/`unresolved`, reusing uploaded images) and `POST
/scans/{scanId}/cancel` (new terminal `canceled` status; skips
  not-yet-dispatched outbox jobs, lets an in-flight attempt finish) are both
  implemented and used from both the single-scan result page and the new
  `/scans/batch/{batchId}` progress page. `/scan` gained a "One record" /
  "Multiple records" mode toggle. `/scans` (history) now server-renders real
  persisted scans via a new `GET /scans` list endpoint instead of demo data.
- `npm run check` passes in WSL on Node 22.23.2: formatting, ESLint, typecheck,
  and 46/46 unit tests.
- `npm run build` passes: the Next.js web app (21 routes), worker, and eval
  package compile cleanly.
- `npm run test:integration` passes in WSL/Docker: database (9), storage (1),
  queue (1), and worker (6) suites, 17/17 total. Migration
  `008_batches_and_scan_lifecycle.sql` (adds `canceled` to `scan_status`, the
  `batches` table, `scans.batch_id`) applied cleanly to the running Postgres
  container.
- `npm run test:e2e` passes in WSL: 5/5 Playwright tests, including a new
  batch-mode scenario (mode toggle, two independent scans, the batch progress
  page, cross-navigation back via "View batch progress"), against a
  production build with the synthetic worker.
- Docker Compose services (postgres, redis, minio) are running and healthy.
- This session's changes are uncommitted on `main`; `main` remains two commits
  ahead of `origin/main` from before this session (nothing pushed).
- The maintainer's private dataset folder contains 52 JPEG cover photos plus a
  draft `manifest.json` and `LABELING_PROMPT.md`. These files remain outside
  the repository and still need app-assisted labels and maintainer verification.
- `packages/evals` provides a private, checkpointed Sol/Terra/Luna comparison
  runner with verified-label/consent gates, per-attempt audit output, aggregate
  quality/routing/latency/token/cost metrics, and non-billable unit coverage.
  Unaffected by the batch change (it only ever submits single-image, ungrouped
  cases).
- Production album identification defaults to `gpt-5.6-sol` + `high` image
  detail. The ignored local `.env` is synchronized to the Sol default.

## Resume point

<!-- The next session starts here. Replace this section when the task
     completes or is re-scoped. -->

**Task:** the third Milestone 2 slice: a thumbnail/normalization pipeline and
worker concurrency limits, followed by batch and provider-cost dashboards.
The private AI matrix remains deferred until public rollout or model/cost
optimization.

Recently completed, for context:

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

- No AI eval baseline; broad model/prompt optimization is not yet measurable.
- A historical live check on one byte-identical 4000x3000 cover photo produced
  three materially different Terra outcomes (no candidate, Cherubs / _Heroin
  Man_, and Cows / _Sexy Pee Story_) in 8.1-25.2 seconds. Production now uses
  the maintainer-accepted Sol + `high` + prompt-v2 path, but still uses
  uncropped images with no catalog retrieval. Multi-view sends more images per
  request, which raises per-scan token/latency cost proportionally; a batch
  of N records now also means N independent provider calls instead of one.
  Neither is yet measured against the deferred eval baseline.
- A fresh Linux/WSL machine needs `sudo npx playwright install-deps` once,
  in addition to `npx playwright install chromium`, or Chromium fails to
  launch with a missing-shared-library error (`libnspr4.so` and similar).
- Cancellation is best-effort: a scan canceled while its attempt is already
  `processing` can still complete and show a result, since no in-flight
  OpenAI call is aborted (ADR-0006, accepted tradeoff). No worker
  concurrency limit exists yet, so a large batch submits all its jobs to
  BullMQ at once — the next roadmap slice adds concurrency limits.
- Authentication is the single development user. All rows are user-scoped, so
  swapping in real identity issuance later does not change the data model.
- Library `PATCH`/`DELETE` endpoints are documented as planned, not
  implemented (`docs/API.md`).
- Local-only infrastructure; backups and observability are Milestone 4.

## Session log

Newest first. One entry per agent session: date, agent, what changed, what was
decided.

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
