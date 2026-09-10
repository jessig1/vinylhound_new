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

## Current state — verified 2026-09-09

- **P3.1 Task 6: structured request/error timing and correlation IDs is
  complete.** Every `apps/web` API route (20 files under
  `apps/web/src/app/api/v1/**`) now shares one `withRoute` wrapper
  (`apps/web/src/server/http.ts`) instead of hand-rolling its own
  `createRequestId`/try-catch/`errorResponse` triplet: it mints the existing
  self-generated `requestId` (unchanged `x-request-id` response contract,
  still `z.string().uuid()` in `ApiErrorSchema`), reads and validates an
  inbound `x-request-id` header as an optional, untrusted `correlationId`
  (`CorrelationIdSchema`, new `packages/contracts/src/common.ts`: trimmed,
  1-200 chars, `[A-Za-z0-9._-]+` only — an absent or malformed value is
  dropped, never rejected, since it is metadata, never identity), and logs one
  `[web] http_request` line (route, method, status, `durationMs`, `requestId`,
  `correlationId`) on every request whether it succeeds or throws. Two probe
  routes (`/api/healthz`, `/api/readyz`) were deliberately left unwrapped —
  no user identity, hit constantly by load balancers, and per-hit structured
  logging there would add log volume disproportionate to their purpose against
  the $25/month budget ceiling.
  The correlation ID is forwarded past the HTTP boundary: `AnalyzeScanJobSchema`
  (`packages/contracts/src/scan.ts`) gained an optional `correlationId` field
  (still `.strict()`; optional means every already-queued JSONB payload
  without it still parses), and migration 013 added a nullable, length-checked
  `correlation_id` column to both `outbox_messages` and `scan_attempts`
  (`packages/database/src/schema.ts`). `submitScan` and `retryScan`
  (`packages/database/src/scan-repository.ts`) accept an optional
  `correlationId` and write it onto both the job payload and the outbox row;
  `prepareScanAnalysis` (`packages/database/src/analysis-repository.ts`)
  copies `job.correlationId` onto the `scan_attempts` row it creates or resets
  on redelivery. `POST /scans/{scanId}/submit` and `.../retry` are the two
  routes that actually thread the request's `correlationId` through (the
  earlier `POST /scans` admission check has no job/outbox row to attach one
  to). One caller-supplied trace value can now be grepped across the HTTP
  request, the queued job, and the worker attempt it produces — never used
  for lookups, joins, or authorization at any hop.
  Timing was split into named phases rather than one opaque duration, without
  adding new `scan_attempts` columns (reusing the existing bundled
  `duration_ms`, per the plan review's instrumentation guidance): the
  upload-complete route (`apps/web/src/app/api/v1/scans/[scanId]/uploads/
[imageId]/complete/route.ts`) now logs `[web] upload_complete_timing` with
  `uploadPhaseDurationMs` (storage readback + validation) and
  `normalizationPhaseDurationMs` (deriving and storing the analysis/thumbnail
  variants) measured separately; the worker's analysis handler
  (`apps/worker/src/analysis-handler.ts`) logs
  `[worker] scan_analysis_timing` with `storageFetchDurationMs` and
  `providerCallDurationMs` split out, on both the success and failure paths.
  `docs/OPERATIONS.md`'s monitoring section now describes this concretely
  instead of asserting request IDs were "already emitted" durably (they
  weren't, before this session — only `scanId`/outbox `id`/job
  `idempotencyKey`/attempt `id` were).
  Verified: `npm run check` (92/92 unit tests, +8: 5 new
  `CorrelationIdSchema` tests in `packages/contracts/src/common.test.ts`, 3
  new `AnalyzeScanJobSchema` compatibility tests in `scan.test.ts`; a new
  `apps/web/src/server/http.test.ts` for `parseCorrelationId` is not counted
  in that unit total's package-only history but runs under the same `vitest
run`), `npm run build` (all 25 web routes present, worker and evals compile),
  `npm run test:integration` (34/34 database, +1: a new test submits a scan
  with a correlation ID and confirms it lands on both the outbox row and the
  `scan_attempts` row `prepareScanAnalysis` creates; storage/queue/worker
  suites unchanged), and a real isolated dev-server pass on port 3100 (the
  maintainer's own port-3000 server was never touched, and the scratch scan
  row this created was deleted from the shared dev database afterward):
  `GET /api/v1/quota` confirmed a missing, valid, and malformed inbound
  `x-request-id` all produce a 200 with the log correctly showing
  `correlationId` as `undefined`, the accepted value, or `undefined` again
  (malformed dropped, not rejected); a full create-scan → create-upload → PUT
  to MinIO → complete-upload cycle against real dev infrastructure produced
  the expected `[web] upload_complete_timing` line with both phase durations
  and the accepted correlation ID.

- **P3.1 Task 4: quota-headroom polling, an early admission check, and
  abandoned-upload cleanup.** `packages/database/src/scan-repository.ts`'s
  `enforceScanQuota` (the transactional, per-user-locked check submit/retry
  already ran) is refactored around a new shared `computeQuotaHeadroom`, so
  every quota read — the authoritative locked one and every advisory one —
  computes the same three numbers the same way and cannot drift. Two new
  advisory (unlocked) call sites reuse it: `getScanQuotaHeadroomForUser`
  backs a new `GET /api/v1/quota` (contract: `packages/contracts/src/
quota.ts`'s `GetQuotaHeadroomResponseSchema`, `{ used, limit, remaining }`
  per dimension plus `admissible`/`blockedBy`), and `createOrGetScan` gained
  an optional `quotaLimits` parameter that rejects a genuinely new scan
  (never an idempotent replay) with `quota_exceeded` before it's even
  inserted when headroom is already clearly exhausted — wired from
  `POST /scans`, so a session with no realistic chance of admission fails
  before the client uploads and normalizes an image rather than only at
  submit. Both are explicitly advisory (can false-pass or false-block under
  concurrency); submit/retry remain the sole authority, unchanged.
  Abandoned-upload cleanup is new end to end: `cleanupAbandonedScans`
  (`scan-repository.ts`) finds `awaiting_upload` scans with no scan-or-image
  activity older than a TTL (candidate query unlocked, then re-verified
  under a row lock before canceling, since `FOR UPDATE` can't combine with
  the aggregate that finds them), cancels them, and returns each image's
  three derived object keys for cleanup. `apps/worker/src/index.ts` runs
  this on its own poll loop (`ABANDONED_UPLOAD_CLEANUP_INTERVAL_MS`, default
  30 min; `ABANDONED_UPLOAD_TTL_HOURS`, default 24h — both new
  `QueueWorkerConfigSchema` fields) alongside the existing outbox poller,
  best-effort deleting the returned objects from storage the same way
  `DELETE /account` does. On the client, `capture-session.tsx` fetches
  `/api/v1/quota` on mount and after any `quota_exceeded` failure, shows a
  banner naming which dimension is blocking (`blockedBy`), disables
  starting/resuming a session while blocked, and polls every 20s while
  blocked and idle — a failed record is never auto-retried, so an exhausted
  daily/spend limit cannot turn into a request loop; the user retries
  manually once the banner clears. `docs/OPERATIONS.md` and
  `docs/ROADMAP.md` (P3.1 Task 5, left unchecked with a
  dated partial-progress note) now document why `USER_ACTIVE_SCAN_LIMIT`
  (20) deliberately equals `MAX_SCANS_PER_BATCH` (20) and why
  `ANALYSIS_CONCURRENCY` is independent of per-user quota; true batch
  rollover (a continuous session spanning more than one batch) is explicitly
  deferred to P3.2, since today's client already hard-caps a session at 20
  records and so never reaches the server-side batch limit in normal use —
  see "Known gaps and risks."
  Verified: `npm run check` (84/84 unit tests, +5: 3 new quota contract
  tests, 2 new worker config tests), `npm run build` (new
  `/api/v1/quota` route), `npm run test:integration` (33/33 database, +3:
  headroom reflects active-scan usage, the early admission check rejects
  before any row is created, abandoned-scan cleanup cancels a backdated scan
  and leaves a recent one alone — storage/queue/worker suites otherwise
  unchanged), and a real isolated dev-server pass (`NEXT_DIST_DIR`-scoped on
  port 3100, matching prior sessions' pattern, so the maintainer's own
  server on port 3000 was never touched): `GET /api/v1/quota` returned a
  real 200 body against actual dev data, and a scripted Playwright check
  confirmed `/scan` shows no quota banner and an enabled "Start capture
  session" button under normal (non-exhausted) quota with zero console
  errors. The isolated instance and its dist dir were removed afterward.

- **P3.1 Task 2: bounded upload concurrency, a persisted session queue,
  retry/cancel, review-later navigation, and refresh recovery for `/scan`.**
  `apps/web/src/app/scan/capture-session.tsx` was rewritten from a single
  global phase/one-record-at-a-time loop into a per-record state machine
  (`idle` / `needs-recapture` / `queued` / `processing` / `failed`) driven by
  a small worker-pool queue (`UPLOAD_CONCURRENCY = 3`): up to three records
  create-scan/upload/complete/submit concurrently, each with its own progress
  bar, retry button, and cancel button (best-effort server-side `cancel` if a
  scan already exists). Once a batch exists, the queue's bookkeeping —
  batch/scan identity and every idempotency key, but never file bytes —
  persists to `localStorage` on every change and rehydrates on mount: a
  record whose image had already been confirmed uploaded resumes as `idle`
  (just needs a submit retry), while one that hadn't shows "Needs recapture"
  with its original filename and a control to reattach a photo, since the
  browser cannot retain `File` objects across a reload. A "N submitted so
  far — review them now" link to `/scans/batch/{batchId}` appears once
  anything has been submitted, so a user is not forced to wait for the whole
  session; the page still auto-navigates there once every record finishes.
  No contract, schema, or API change — this is purely a client-side queue
  built on the existing `/batches`, `/scans`, `/scans/{id}/uploads`,
  `/scans/{id}/uploads/{id}/complete`, `/scans/{id}/submit`, and
  `/scans/{id}/cancel` routes.
  Two real bugs were found and fixed during verification, both specific to
  the recapture-after-refresh path (an untested seam before this session):
  (1) reattaching a _different_ photo than the original while reusing the
  original upload/complete idempotency keys hit the server's idempotency
  conflict guard (`409`, "idempotency key already used with different image
  data"), since those keys' payload includes the file's checksum/size; (2)
  even after minting fresh upload/complete keys, reusing the _same scan_
  left the original, never-completed image registration attached to it,
  and the server correctly refuses to submit a scan with any incomplete
  registered image (`409`, "All registered images must finish uploading
  before submission") — an interrupted-then-resumed record can never
  progress on the same `scanId`. The fix: `attachRecapture` now discards the
  old scan entirely (best-effort `cancel`, fire-and-forget) and mints a
  whole new `scanKey`/`submitKey`/`uploadKey`/`completeKey` set, so a
  reattached photo always starts a clean scan rather than resuming a
  partially-registered one. A third bug was in the verification approach,
  not the product: relying on a value assigned inside a `setRecords`
  updater immediately after calling it (to detect "was this the last
  record, so auto-navigate now") silently never fired, because that updater
  does not run synchronously outside a React event handler — fixed by
  tracking the pending-record count in a plain ref (`pendingCountRef`)
  instead, which is the only value the auto-navigate check now reads.
  Verified: `npm run check` (79/79 unit tests), `npm run build`, and a
  scripted Playwright pass against a real dev server (Postgres/Redis/MinIO,
  `AUTH_MODE=development`) with real small PNGs — confirmed at most 3
  concurrent uploads, a mid-upload reload producing the resume banner with
  correct per-record needs-recapture/ready state, a full recapture-with-a-
  different-photo-then-resume cycle completing with zero console errors and
  a correct auto-navigate, and a queued/mid-upload record's cancel button
  correctly excluding it from the resulting batch (3 of 4 scan cards, as
  expected). Manual dev-server verification needed its own isolated
  `next dev` instance (`NEXT_DIST_DIR`-scoped, matching the existing e2e
  pattern) because another `next dev` was already holding the project's
  usual dev lock; that instance and all scratch files were removed
  afterward, and the pre-existing dev server on port 3000 was left running
  and untouched throughout.
- **Library UX pass: real cover art, an album detail page, and records that can
  actually be removed (ADR-0018).** The maintainer asked for a broad UI/UX
  review "as a user looking to scan albums, review album details, add, edit and
  delete lists," naming missing scan thumbnails and dead-end wishlist cards.
  Four things changed:
  1. **Real covers everywhere.** A shared `CoverArt` client component
     (`apps/web/src/app/cover-art.tsx`) layers the signed thumbnail over the
     existing tone placeholder, so a missing or slow image never shifts layout.
     It requests signed reads only as artwork nears the viewport
     (`IntersectionObserver`), since a library page can hold 100 covers and each
     one costs a request. Used by the dashboard activity rows, the dashboard
     collection/wishlist previews, `/scans` history, the library grids, and the
     detail page. This closes rank 9 of `docs/UI_UX_REVIEW.md`, which had been
     deferred as a separate task, and the scan-history half of P3.4's image-read
     item. The batch review page keeps its own `BatchThumbnail` (a different
     fixed-size card shape) and was deliberately left alone.
  2. **A library item detail page** at `/library/{itemId}` — collection and
     wishlist cards are now links to it, which is what "clicking a wishlist item
     does nothing" was about. It shows the cover, full release facts, a
     MusicBrainz link (rendered only for `https://` URLs, since the reference
     arrives through a client-sent confirmation body), editable notes, per-copy
     editors, list actions, and a link back to the originating scan.
     `getLibraryItemForUser` is the new repository read; `LibraryItemResult`
     gained `coverImage` (`{ scanId, imageId } | null`), batch-loaded in one
     query. Note `apps/web/src/app/library/layout.tsx` re-exports the dashboard
     layout — without it the route renders with no app shell, which is how every
     other authenticated section here works.
  3. **Editing feedback.** The grid no longer carries inline editors. The copy
     editor gained the media/sleeve condition fields the API already supported,
     real error/pending/saved states, and an inline delete confirmation instead
     of `window.confirm`; it previously ignored failures entirely. Notes are now
     editable at all (`PATCH /library/{itemId}` supported `notes` with no UI).
  4. **Records can be removed.** See ADR-0018 below.
- **ADR-0018 supersedes ADR-0011's delete restriction.** Migration 012 makes
  `scan_confirmations.library_item_id` nullable with `on delete set null`.
  Previously that `restrict` FK meant nearly every real library item was
  permanently undeletable — ADR-0011 recorded this as "effectively a no-op path
  for real data," and the UI hid "Remove" for anything with
  `confirmedFromScanId`. Now the item deletes, its copies cascade, and the
  confirmation keeps `scan_id`/`release_id`/`reviewed_release`/`confirmed_at`;
  only the item pointer clears. Three reads follow: `getScanConfirmationForUser`
  returns null (the scan is reviewable again), `confirmScan` replaces the stale
  row instead of raising its "already confirmed" conflict (otherwise removal
  would permanently block re-saving that scan, since `scan_id` is the PK), and
  the account export left-joins with `libraryItemId`/`list` nullable so the
  decision is still exported.
- **Verification for the above:** `npm run check` (79/79 unit tests),
  `npm run build`, `npm run test:integration` (30/30 database — +2 net new
  covering removal-keeps-the-audit-row, re-saving after removal, and the cover
  lookup — plus storage/queue/worker), a scripted 14-step browser pass against a
  running dev server (wishlist card → detail, notes round-trip, move to
  collection, copy edit persistence, copy removal, delete-with-confirm →
  redirect, scan still in history, 404 on unknown id — all passing), axe
  WCAG 2 A/AA with zero violations on dashboard/collection/wishlist/scans/detail,
  and a Pixel 7 pass with no horizontal overflow. Seeded data and scratch
  scripts were removed afterward.
- **Watch out:** one existing integration test
  (`confirms a reviewed result idempotently…`) asserts a **global** count of
  `catalog_references` rows rather than scoping to its own data, so any seeded
  development data makes it fail. This bit this session and cost a false
  regression scare; it is pre-existing test fragility, not a code bug.

- **Dashboard "Latest scans" now supports inline add/dismiss per scan
  (ADR-0017).** The maintainer asked, outside the roadmap sequence, to (1)
  confirm the dashboard shows each scan result individually rather than as a
  batch — already true, since `listScansForUser` has always projected one row
  per scan (ADR-0006) — and (2) let a user add a scan's top candidate to their
  collection/wishlist or dismiss it without leaving the dashboard. `cancelScan`
  (`packages/database/src/scan-repository.ts`) now also accepts `identified`,
  `needs_review`, `unresolved`, and `failed` as cancelable pre-states
  (transitioning to `canceled`), rejecting with `invalid_state` if the scan
  already has a `scan_confirmations` row — no new status or endpoint.
  `listScanSummariesForUser` now also returns `confirmedList` (`"collection" |
"wishlist" | null`) via one batched query joining `scan_confirmations` to
  `library_items` across the requested scan IDs. A new client component,
  `apps/web/src/app/dashboard/scan-activity-row.tsx`, renders each row and
  calls the existing `POST /scans/{scanId}/confirm`/`cancel` routes, then
  `router.refresh()` rather than tracking optimistic local state. The
  dashboard-only label "Dismissed" replaces "Canceled" purely as presentation
  in that component; every other page still says "Canceled" for the same
  status. Verified: `npm run check` (79/79 unit tests), `npm run build`,
  `npm run test:integration` (28/28 database tests, +2 new: dismiss a
  reviewable result, reject dismissing a confirmed one), and manual
  verification against a running dev server with seeded data (screenshotted,
  then cleaned up) — dismiss and add-to-collection both worked end to end,
  including the server-side rejection when dismissing an already-confirmed
  scan. The Playwright e2e suite could not be used to verify this locally; see
  "Known gaps and risks."

- **Phase 3-4 roadmap is now written.** At the maintainer's request,
  `docs/ROADMAP.md` replaces the placeholder with P3.1-P3.5 product maturity
  and P4.1-P4.5 measured service extraction. It incorporates the plan review's
  corrections/prerequisites, names staging/ECS for demonstrations, preserves
  Phase 2 gates, and defers training beyond Phase 4. P3.1 Task 1 is now
  implemented: `/scan` uses an extracted capture-session component instead of
  the one-shot mode toggle, creates independent scans under an existing batch,
  and exposes one upload-only control with one cover per record. The remaining P3.1
  queue persistence, quotas, tracing, and cost inventory are not implemented.
  Batch review now presents private signed thumbnails and basic candidate details,
  with one-tap high-confidence add-to-collection or wishlist actions; current
  architecture ADRs still apply until a future cutover.

- **Staging activation:** staging publishes and reuses isolated
  `<sha>-staging` image tags and promotes verified digests to
  `staging-passed-<sha>` idempotently. After the maintainer approved copying the
  ignored local development/test Clerk and OpenAI values into staging Secrets
  Manager, run `34038709907` passed migrations, service readiness, smoke tests,
  and image promotion. Its final deactivation encountered a transient AWS
  eventual-consistency error while releasing a NAT EIP whose ENI had already
  disappeared. Teardown applies now retry up to three times with bounded delay
  in staging and both production cleanup paths. Run `34040437776` completed the
  full lifecycle successfully for retry commit `fd99943`, including final
  deactivation, and promoted its images for production.

- **Production activation: six attempts across two sessions, five distinct
  real bugs found, four fixed and verified; one (#8) still open and is the
  current blocker.** Run `34041389496` got past secret creation but failed at
  "Verify runtime secrets" (exit 254); self-resolved on retry once secrets
  were consistently readable. Run `34042087635` failed provisioning the EKS
  node group with an ARM64/x86 AMI-type mismatch; fixed in commit `506767e`.
  Run `34145509904` cleared EKS provisioning but failed "Migrate database"
  with `CreateContainerConfigError` (Secret read 6ms after creation, before
  EKS API-server propagation); fixed in commit `5c098b6` (poll for
  readability; upgraded diagnostics to `describe job`/`describe pods`/`logs
--all-containers`). Run `34153511737` cleared EKS provisioning and the
  secret-propagation race but failed "Migrate database" again with
  `runAsNonRoot: true` unable to verify a non-numeric `USER node`; fixed in
  commit `beeb98a` (`USER node` → `USER 1000:1000` in both `Dockerfile.web`
  and `Dockerfile.worker`).
  **This session (continuing the same day): run `34160436572`** (commit
  `beeb98a`, after staging passed clean on it) cleared EKS provisioning,
  Kubernetes Secret propagation, `runAsNonRoot`, **and** "Migrate database"
  and "Deploy Kubernetes workloads" for the first time ever — but failed
  "Smoke test CloudFront path" with a persistent `504` on every one of 19
  retry attempts across ~13 minutes, despite `kubectl rollout status`
  reporting both `web` and `worker` successfully rolled out. Root cause not
  yet found; narrowed to somewhere between the ALB target group and the pod
  (candidates: target-group health-check timing, a security-group mismatch,
  NodePort/kube-proxy routing, or the CloudFront VPC origin itself) —
  tracked as **issue #8**, now the sole blocker for P2.2/P2.6.
  **A serious secondary incident followed**: this run's own 61m19s runtime
  exceeded the GitHub OIDC role's default 1-hour AWS session, so its
  automatic post-failure cleanup ("Deactivate after failed runtime
  deployment") died mid-destroy with `ExpiredToken` while EKS node group and
  CloudFront distribution deletes were still polling, and could not persist
  Terraform's state to S3. This left (a) a live, undestroyed production
  runtime — EKS, ALB, CloudFront, WAF, NAT gateway all still running, though
  the SSM `/vinylhound/production/active` flag had already flipped to
  `false` earlier in the same apply, before the token died; and (b) an
  orphaned Terraform state lock. Because `deactivate-environment.yml`
  (both its hourly schedule and a manual `workflow_dispatch`) trusts that
  SSM flag as its sole signal, it silently no-op'd twice in a row — a
  `workflow_dispatch` run completed "successfully" in 11 seconds having
  skipped every teardown step, while the maintainer independently confirmed
  via the AWS Console that EKS/ALB/CloudFront/NAT/WAF were all still live.
  Root-caused and resolved live: added `skip_activation_check` (commit
  `69854cb`) and `stale_lock_id` (commit `57e6a3e`) emergency
  `workflow_dispatch` inputs to bypass the SSM gate and force-unlock the
  orphaned lock respectively; also hardened the SSM read itself (commit
  `b2e0d5f`) so a real AWS API failure now fails loudly instead of being
  silently treated as "already inactive." Run `34165576307` then
  successfully destroyed the remaining 5 resources (ALB, target group,
  listener, WAF, CloudFront VPC origin — EKS/CloudFront distribution/NAT had
  apparently already finished deleting asynchronously before the original
  run's token died, Terraform just hadn't recorded it) and the maintainer
  independently reconfirmed via the Console that everything is gone. Aurora
  (serverless, `min_capacity = 0`) and the VPC/subnets/foundation remain, by
  design (ADR-0016's persistent data plane) — this is expected residual cost,
  not a leftover bug. Filed as **issues #9** (the session-duration root
  cause — needs `max_session_duration` raised on `aws_iam_role.github_deploy`
  in the bootstrap root) **and #10** (review/harden the emergency bypass
  inputs, which were written fast under pressure and should not be
  considered a permanent, fully-reviewed part of the normal flow).
  Staging was never affected by any of this — it deploys via ECS, not EKS,
  and its own deactivation for this same commit completed cleanly with no
  errors.

- **GitHub configuration script:** the repository administration helper is now
  Bash (`scripts/configure-github-repository.sh`) rather than PowerShell. It
  retains the public-visibility safety gate and the same repository, security,
  workflow-permission, label, and branch-protection settings. Pass an optional
  `OWNER/REPOSITORY` as its first argument; the VinylHound repository remains
  the default. GitHub rejects attempts to explicitly enable Advanced Security
  on a public repository because it is already available there, so the Bash
  payload omits only that redundant API field.

- **P2.1-P2.4 review:** repository implementation is complete; the remaining
  work is GitHub/AWS configuration and live rehearsal, summarized in
  `docs/PHASE_2_MILESTONE_REVIEW.md`. Live inspection confirmed the repository
  is now public and full-history Gitleaks passes. General merge settings have
  the documented values, but branch protection and the remaining security
  endpoints are not yet enabled. All three GitHub environments exist, only
  development has deploy variables, staging/production variables are absent,
  repository plan variables still contain invalid placeholders, only
  development Terraform state exists, the development ARM64 Lambdas exist, and
  no ECS/EKS clusters exist. Successful staging runs are guard skips, not
  lifecycle passes. The review also removed the accidentally tracked local AWS
  CLI installer bundle from Git and ignored `/aws/`; that bundle caused the
  latest CI formatting failure.

- **Incremental frontend usability pass:** the maintainer explicitly authorized
  the ranked UI work in `docs/UI_UX_REVIEW.md`, superseding the older UI deferral
  for this task. Changes cover mobile scan-row navigation, shared controls and
  contrast, uncropped previews, optional copy fields, review/processing feedback,
  and clear-search recovery. Backend contracts and architecture are unchanged.
  Verified: 56/56 browser checks across all four profiles, 79/79 unit tests,
  lint, typecheck, formatting, and production build pass. The subsequent Phase
  2 review excluded local AWS CLI and Terraform state artifacts from repository
  tooling, so the full `npm run check` now passes.

- **The tiered AWS runtime redesign is implemented and verified for milestone
  delivery.**
  ADR-0016 supersedes ADR-0015: development is an always-live, scale-to-zero
  API Gateway/Lambda environment backed by external PostgreSQL, staging keeps
  the just-in-time ECS shape, and production is now a just-in-time EKS runtime
  behind CloudFront, WAF, and an internal ALB. AWS environments use SQS FIFO
  queues with DLQs while local development keeps BullMQ. Production teardown
  drains workers before removing the namespace; application access uses EKS
  Pod Identity, and container migration/runtime entrypoints no longer depend on
  npm being present in the hardened images.
- Verification through 2026-09-05: `npm run check` passes all 79 unit tests;
  `npm run build` succeeds; actionlint 1.7.7 reports no workflow findings;
  kubeconform 0.7.0 validates all 10 production Kubernetes resources; and
  Terraform 1.13.3 formats and validates bootstrap, development, staging, and
  production roots against committed provider locks. The worker shared-package
  runtime compilation also succeeds. `npm run container:build` now builds all
  three images. Local smoke tests prove web liveness/readiness/root responses
  and Docker health, worker migrations/heartbeat/clean SIGTERM shutdown, and
  Lambda cold start, EventBridge dispatch, and SQS partial-batch failure. All
  runtimes are non-root and omit npm; tests made no OpenAI calls and removed
  their disposable containers/databases. No real AWS plan/apply was attempted.
- Terraform 1.13.3 is installed for both Windows and WSL. The exact WSL
  `terraform -chdir=infra/terraform/bootstrap init` command succeeds and the
  bootstrap root validates with AWS provider 6.62.0. Its lock now includes the
  Linux package hash alongside the Windows hash. All four roots also pass
  formatting and Windows validation; GitHub's Linux Terraform validation job
  passed for milestone commit `fdece7b`.

- **Do not make the repository public yet.** The real Gemini credential found
  in historical `.env.example` was rotated, and its only containing branch,
  `experiment/gemini-vs-openai`, was deleted locally and on GitHub on
  2026-09-02. `main` never contained the exposing commit; a local ref audit and
  GitHub `ls-remote` both confirm no remaining branch points to it. The next
  push must produce a clean full-history Gitleaks workflow run before the
  visibility-change gate can pass. Never add an allowlist for a real finding.
- **Initial GitHub workflow failures are resolved.** The follow-up commit
  `a8bdff5` passed CI, Security (including a clean full-history Gitleaks scan),
  staging's pre-activation guard, Terraform validation, and both container
  build/Trivy/SBOM jobs on 2026-09-02. Private-repository SARIF/CodeQL uploads
  now wait for the public visibility gate; staging and scheduled deactivation
  skip safely until configured, while manual production activation validates
  and fails clearly when configuration is missing. Runtime images remove unused
  npm/corepack package-manager tooling, eliminating its inherited Trivy findings.

- The dashboard now reads authenticated, persisted data rather than the old
  hard-coded demo dataset: its activity section shows the three most recent
  scans, and its collection/wishlist previews show the three most recently
  updated items and exact server-side counts. Empty states are explicit. This
  work is committed on `main`.

- **Milestone 4's managed-infrastructure/operations task is complete at the
  repository level.** `docs/OPERATIONS.md` defines the managed PostgreSQL,
  Redis, and object-storage topology; backup retention; monthly recovery
  drill; health checks; log/alert signals; and production secret boundaries.
  `npm run ops:restore-test` takes a local Compose logical DB backup, restores
  it to `vinylhound_restore_verification`, validates migration metadata, then
  drops that isolated verification database; it passed on 2026-08-31. Public
  `/api/healthz` (process) and `/api/readyz` (PostgreSQL) probes are excluded
  from Clerk protection for external monitoring. Before each first submission
  or retry, the server serializes per-user quota checks using a PostgreSQL
  advisory transaction lock: daily outbox volume, queued/processing scans,
  and rolling actual token cost plus a configured reservation for each active
  scan. Exceeding a limit returns 429 `quota_exceeded`; defaults and required
  production configuration are in `.env.example`/`docs/OPERATIONS.md`.

- **Milestone 4 Task 4, accessibility and cross-device testing, is complete.**
  `@axe-core/playwright` checks WCAG 2 A/AA violations on dashboard, scan,
  collection, wishlist, and account routes, and an e2e assertion verifies a
  keyboard-visible focus target. The app shell has a skip-to-content link,
  `:focus-visible` treatment, and reduced-motion support; destructive account
  confirmation input and client-side error messages now have explicit labels
  and alert semantics. Playwright projects define a fast Pixel 7 Chromium gate
  plus desktop Chromium, desktop Firefox, and iPhone 13 WebKit coverage via
  `npm run test:e2e:matrix`. Firefox and WebKit engines are installed locally.

- **Milestone 4 Task 1, production authentication, is complete** (ADR-0013).
  Clerk (`@clerk/nextjs@^7.8.3`) resolves session identity when
  `AUTH_MODE=production`: `apps/web/src/proxy.ts` (Next.js 16's Proxy
  convention, replacing the deprecated `middleware.ts`) protects every route
  except `/`, `/sign-in`, and `/sign-up`, and a new `requireUserId`
  (`apps/web/src/server/auth.ts`) replaces every route/page's old
  `context.config.DEVELOPMENT_USER_ID` read. Clerk's user ID maps to the
  existing `users.id` UUID via a new unique `clerk_user_id` column
  (migration 011), provisioned just-in-time on first request
  (`getOrCreateUserIdByClerkId`) rather than via a webhook. `AUTH_MODE`
  (now `"development" | "production"`, was a single-value literal) and a
  client-visible `NEXT_PUBLIC_AUTH_MODE` mirror stay the real switch:
  `AUTH_MODE=development` (the default, matching `.env.example`) needs no
  Clerk keys and behaves exactly as before, so local dev/CI/tests are
  unaffected — `clerkMiddleware()` itself throws on a missing publishable
  key, so the proxy and `<ClerkProvider>` both skip constructing Clerk
  entirely in development mode rather than gating inside it (a real hang in
  the e2e run caught the first, wrong version of this that gated Clerk from
  the inside). `/sign-in` and `/sign-up` use Clerk's default hosted
  `<SignIn>`/`<SignUp>` components; `/` is now a static landing page (the
  fake demo sign-in/sign-up form that used to live there is gone); `/account`
  and the sidebar name/avatar now read Clerk's `useUser`/`useClerk` in
  production mode and show a neutral development-mode label otherwise. The
  fake `vinylhound-demo-session` `localStorage` key is gone.
- **Milestone 4 Task 2, account export and deletion, is complete** (ADR-0014).
  `GET /account/export` (`getAccountExportForUser`,
  `packages/database/src/account-repository.ts`) returns every row a user
  owns — account, batches, scans, image metadata (not image bytes),
  attempts, confirmations, library items, library copies — as JSON with a
  `content-disposition: attachment` header; a new `packages/contracts`
  `account.ts` defines the strict response shape. `DELETE /account`
  (`deleteAccount`) performs an ordered hard delete in one transaction: the
  user's `scan_confirmations` rows are deleted directly first (their
  `library_item_id`/`release_id` FKs are deliberately `restrict`, ADR-0011,
  which would otherwise block the `users` cascade from also removing
  `library_items`), then the `users` row, letting every other user-owned
  table cascade normally; shared `albums`/`releases` rows are never touched
  since they carry no FK to `users` at all. After the transaction commits,
  each deleted image's `original`/`analysis`/`thumbnail` S3 objects (all
  three variants recomputed via `deriveImageObjectKey`, since only the
  `original` key is stored in a column — ADR-0007) are deleted best-effort;
  a failed object delete is logged, not retried, and does not fail the
  request. `/account` gained a "Your data" section
  (`account-data-actions.tsx`) with an "Export my data" download button and
  a type-to-confirm ("delete my account") destructive delete flow, working
  in both `AUTH_MODE=development` (redirects to `/` afterward) and
  `AUTH_MODE=production` (calls Clerk's `signOut()` afterward, since the
  Clerk session itself is independent of the now-deleted local row).
  `docs/SECURITY.md`'s retention section now states the actual policy
  (retained until the user deletes their account; no automatic time-based
  expiry) instead of describing an undefined future policy.
- **This session also destroyed the accumulated local dev database history**
  under `DEVELOPMENT_USER_ID` (scans, images, library items, batches built
  up across every prior session's manual testing) by mistake: a `curl -X
DELETE` intended only to inspect response headers while manually verifying
  the new endpoint executed for real. A fresh, empty `users` row was
  auto-reprovisioned under the same ID on the next request, so the app still
  works, but every reference in this file's history to specific accumulated
  counts (e.g. "21 scans," "48/12" collection/wishlist counts shown in
  screenshots) no longer reflects the database's actual contents — the
  maintainer confirmed this local data did not need recovering. This is a
  concrete illustration of why `DELETE /account` needs a real confirmation
  step before ever being invoked, automated or manual, against non-disposable
  data.
- This session also installed Node 22.23.2 side-by-side via nvm-windows on
  the Windows host (`nvm use 22.23.2`), since the machine's only prior Node
  was v20.17.0 and this repo's scripts (`db:migrate`, `test:integration`,
  the e2e `globalSetup`) require Node ≥21.7 for `--env-file-if-exists`. This
  finally makes `npm run check`/`test:integration`/`test:e2e` runnable
  directly on Windows for this machine, not just in WSL as prior sessions
  required.
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
- Milestone 3 Task 1 is complete. `docs/CATALOG_EVALUATION.md` and ADR-0009
  select MusicBrainz as the primary canonical catalog (release group = album,
  release = edition), with Discogs deferred as an optional pressing cross-check
  requiring a fresh terms/attribution/caching review.
- Milestone 3 Task 2 is complete. `packages/catalog` provides the catalog port
  and MusicBrainz adapter with a meaningful User-Agent, serialized 1 req/s
  access, 429/503 retry, and 24-hour in-memory cache. The review page exposes a
  user-triggered catalog search and persists selected release-group/release
  MBIDs plus source/fetch provenance. Migration 010 adds richer release fields,
  namespaced `catalog_references`, and `library_copies`; repeated owned
  confirmations reuse one library item but create separate physical copies
  (ADR-0010).
- Milestone 3's direct wishlist-to-owned conversion slice is complete
  (ADR-0011): `PATCH`/`DELETE /library/{itemId}` let a user move a wishlist
  item to owned (creating one blank copy, matching confirmation's rule) or
  edit notes, without a rescan. Moving an owned item back to wishlist is
  rejected while it still has copies. `DELETE` rejects with `invalid_state`
  whenever the item has `scan_confirmations` history — true of nearly every
  real item — since `scan_confirmations.library_item_id` is a `restrict` FK
  protecting the audit trail; the collection/wishlist pages hide "Remove" for
  any item with `confirmedFromScanId` set.
- **Milestone 3 is now complete** except per-copy edit/delete, which stays
  explicitly deferred (see Resume point). Library search, sort, and CSV export
  shipped this session (ADR-0012): `GET /library` accepts `q` (trimmed, max
  200 chars) and `sort` (`recent`/`artist`/`title`, default `recent`),
  validated together with `list` by a new `LibraryQuerySchema`. Matching and
  sorting operate on the same effective artist/title the response already
  returns (which prefers a scan confirmation's corrected values over the
  shared album row) rather than raw SQL columns, applied after the existing
  100-item fetch. A new `GET /library/export` route returns the same
  filtered/sorted list as `text/csv` with a `content-disposition: attachment`
  header. The collection/wishlist pages' previously non-functional search box
  and sort button are now a real, debounced (300ms) client toolbar
  (`library-toolbar.tsx`) that updates the URL (`router.replace`), which the
  server component re-reads; an "Export" link points at the new route with
  the current `list`/`q`/`sort`.
- `npm run check` passes in WSL on Node 22.23.2: formatting, ESLint,
  typecheck, and 61/61 unit tests.
- `npm run build` passes: the Next.js web app (26 routes, including the new
  `/api/v1/library/export` route), worker, and eval package compile cleanly.
- `npm run test:integration` passes in WSL/Docker: database (19), storage (1),
  queue (1), and worker (6) suites, 27/27 total. Confirmation coverage includes
  catalog provenance, wishlist conversion, two physical copies sharing one
  user/release library item, the direct-update/delete paths (including the
  copies-present/confirmation-history rejection cases), and the new
  search/sort test (artist-substring match, title-substring match, artist
  sort order, and a no-match case).
- `npm run test:e2e` passes in WSL: 5/5 Playwright tests against a
  production build with the synthetic worker (unchanged by this session).
- Manually verified search, sort, and CSV export in a running WSL dev server
  against real seeded data (two directly-inserted albums, since the database
  was otherwise empty of collection/wishlist items): `?q=miles` correctly
  narrowed to the matching item, `?sort=artist` reordered results, the CSV
  response had the correct `content-type`/`content-disposition` headers and
  correctly quoted an embedded `"` in `12" Vinyl`, and both `?q=`/`?sort=`
  round-tripped into the server-rendered search input's `value` and the
  sort `<select>`'s selected `<option>`. Manually-seeded rows were deleted
  afterward; pre-existing real data (a "Chevelle" item and leftover rows from
  earlier WSL integration test runs against the same database) was left
  untouched.
- Manually verified `/account/usage` and `/account` in a running dev server
  (WSL, real Postgres data): both render real accumulated data
  (21 scans, $0.45 estimated spend, 83,112 tokens) with no console errors;
  confirmed the mobile bottom nav does not actually clip the last stat row
  (a `fullPage` screenshot made it look clipped, but scrolling to the
  bottom shows `content-page`'s existing 100px bottom padding clears it).
  This session found the same Docker Postgres instance empty (0 scans, 0
  library items) rather than holding that accumulated data — worth noting for
  whoever resumes next, since it means the 21-scan dataset referenced above no
  longer reflects the database's actual contents. This session manually
  verified the new `PATCH`/`DELETE /library/{itemId}` routes' error paths
  (not-found, invalid body, bad UUID) against a running WSL dev server instead,
  since there was no real library item to exercise the success path against.
- `npm run check` passes on Windows (Node 22.23.2 via nvm-windows, not WSL):
  formatting, ESLint, typecheck, and 69/69 unit tests (61 before this
  session, +4 `DevelopmentWebConfigSchema` auth-mode tests for task 1, +4
  `AccountExportResponseSchema`/`DeleteAccountResponseSchema` tests for
  task 2).
- `npm run build` passes: the Next.js web app (30 routes: +2 for
  `/sign-in`/`/sign-up` in task 1, +2 for `/api/v1/account` and
  `/api/v1/account/export` in task 2), worker, and eval package compile
  cleanly. A build warning about `process.cwd`/Edge Runtime originates
  inside `@clerk/nextjs`'s own module graph, not this repo's code, and does
  not fail the build.
- `npm run test:integration` passes on Windows (Node 22.23.2): database (25:
  21 before this session, +2 for `getOrCreateUserIdByClerkId` in task 1,
  +2 for account export/deletion in task 2 — export, export-not-found,
  delete-with-restrict-fks, delete-not-found), storage (1), queue (1), and
  worker (6) suites, 33/33 total. Migration 011 applied cleanly to the real
  dev database.
- `npm run test:e2e` passes: 5/5 Playwright tests against a production build
  with the synthetic worker, run in `AUTH_MODE=development` (unaffected by
  Clerk, as designed) — the task 1 run caught a real
  `clerkMiddleware()` construction-time throw described above; the task 2
  rerun after adding the account endpoints was unaffected.
- Manually verified in a running dev server: `GET /account/export` against
  real accumulated dev data (correct headers, schema-valid body);
  `/account`'s new "Your data" section renders and its delete flow's
  type-to-confirm gating (button stays disabled until the exact phrase is
  typed, "Cancel" resets state) was exercised end-to-end with a scripted
  Playwright check, screenshotted for visual confirmation. Manually invoking
  `DELETE /account` to check response headers was a mistake — it executed
  for real against the shared dev account and destroyed its accumulated
  scan/library history (see the note above); nothing else in this session's
  verification was destructive.
- Docker Compose services (postgres, redis, minio) are running and healthy.
- Milestone 2's original work is committed through `a248eb9`; the subsequent
  audit fixes, MusicBrainz catalog integration, physical-copy model, related
  docs/tests, and the hydration-warning adjustment are committed as `c8f99cd`.
  Direct wishlist-to-owned conversion (ADR-0011) and library search/sort/
  export (ADR-0012) are committed as `b2d87d6`. Production authentication
  (ADR-0013) is committed as `9507cad`. All of the above are pushed to
  `origin/main`. Account export/deletion (ADR-0014) is committed as `6511205`.
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

The requested incremental frontend pass is documented in `docs/UI_UX_REVIEW.md`.
Review those local changes before committing. Real cover art, batch review
navigation, and copy-editor mutation feedback remain separate tasks.

**Task, as of 2026-09-07 (second session of the day):** the maintainer decided
to stop pursuing a fully-passing production activation in-session — five real,
distinct bugs were found and four fixed across two sessions (see Current
state), the fifth (#8, the ALB/CloudFront 504) needs its own focused
investigation rather than more blind retries. Both staging and production were
deliberately torn down and confirmed inactive (staging via its own clean
pipeline deactivation; production via the emergency `skip_activation_check`
path after an incident — see Current state and issues #9/#10). All outstanding
Phase 2 work was converted into GitHub issues (**#8–#15**) rather than staying
implicit in this file, and the maintainer wants to move toward Phase 3 given
development is stable — Phase 2 is **not** being marked complete or tagged;
it's being left in a clean, fully-tracked, non-costing state while priorities
shift.

**Current infrastructure state (verified 2026-09-07):**

- **Development**: live, always-on, unaffected by anything in this session.
  `https://dev-vh.siliconforest.io`.
- **Staging**: inactive. Last full lifecycle run (`34158399023`, commit
  `beeb98a`) passed completely — build, migrate, deploy, smoke test, image
  promotion (`staging-passed-beeb98aa4cc5eb071c9b158426ef182f8e792f68`), clean
  deactivation. No known issues.
- **Production**: inactive, confirmed via both Terraform apply output
  (`environment_active = false`, no errors) and the maintainer's direct AWS
  Console check. EKS, ALB, CloudFront distribution, WAF, and NAT gateway are
  all destroyed. Aurora (serverless, scaled to zero compute) and the VPC/
  subnet/foundation layer remain, by design (ADR-0016's persistent data
  plane) — this is expected residual cost, not a leftover bug; the maintainer
  asked about this specifically and was walked through why.

**Open issues tracking all remaining Phase 2 work** (filed this session,
replacing the old "Immediate next steps" list that used to live here):

- **#8** — the actual blocker: production's ALB/CloudFront returns a
  persistent 504 even though Kubernetes reports both deployments successfully
  rolled out. Root cause not yet found; needs its own investigation session
  with real `aws elbv2 describe-target-health` / `kubectl get endpoints`
  output, not another blind retry.
- **#9** — the GitHub OIDC session (1hr default) is too short for slow
  EKS/CloudFront destroy operations; this caused a real incident this session
  (a live, briefly-unaccounted-for production runtime). Fix: raise
  `max_session_duration` on `aws_iam_role.github_deploy`
  (`infra/terraform/bootstrap/main.tf`) — needs a bootstrap-root apply with an
  AWS administrator identity, not GitHub OIDC.
- **#10** — review/harden the emergency `skip_activation_check`/
  `stale_lock_id` workflow_dispatch inputs added live during #9's recovery
  (commits `69854cb`, `57e6a3e`); they worked but were written fast under
  pressure and deserve real review before being trusted as a standing
  capability.
- **#11** — standardize and audit AWS resource tagging (explicitly requested
  by the maintainer); `docs/OPERATIONS.md` now documents the existing
  convention and its gaps (commit `47c3123`).
- **#12, #13, #14, #15** — the remaining P2.1/P2.2/P2.5/P2.6 roadmap items
  (fork PR rehearsal, Lambda/Fargate demonstrations, load/failure/restore
  drills, full rehearsal + evidence publication), each already flagged in
  this file historically as genuinely manual or blocked on #8.

**Whoever picks this up next should NOT default to resuming Phase 2
production work** unless the maintainer asks for it again — the explicit
instruction this session was to move toward Phase 3 now that development is
stable. Read whatever the maintainer's next request actually is; if it's
Phase 3 scoping, start there fresh rather than assuming Phase 2 continuation.
If a future session does return to Phase 2, the issues above are the
authoritative task list — this file's old inline "Immediate next steps" is
gone because it went stale within the same day it was written and the issues
are now the better-maintained source.

**Separately, not blocking anything above:** the maintainer's local AWS CLI
session (`aws sts get-caller-identity`) is expired and authenticates via a
custom `login_session`-based credential process (`~/.aws/config` has
`login_session = arn:aws:iam::138010381178:root`, not standard AWS SSO) that
cannot be reauthenticated non-interactively — flag it, don't attempt it. It
does not block GitHub Actions, which authenticate via OIDC independently
(this is exactly the credential path that produced the #9 incident, so bear
that in mind if debugging anything OIDC/session-related).

**Phase 3-4 planning is complete for this request (2026-09-08).**
Read `docs/ROADMAP.md` for sequence, dependencies, deliverables, and measurable
exit criteria. `docs/PHASE_3_4_PLAN_REVIEW.md` remains the historical review.
P3.1 Task 1 (capture-session flow), Task 2 (bounded upload concurrency/
session queue/retry/cancel/review-later/rehydration), and Task 3 (the signed
image-read slice) are complete.
Its extracted `CaptureSession` replaces `/scan`'s mode toggle with one
upload-only control: every selected cover photo forms an independent record
draft, and starting the session creates one batch and submits records
independently, at most three at a time, with per-record retry/cancel and a
"review them now" link to the batch page once anything has submitted. A
refresh mid-session restores the queue's bookkeeping from `localStorage`
(batch/scan identity and idempotency keys) and marks any record whose image
never finished uploading as needing its photo reattached, since the browser
does not retain file bytes across a reload. Batch cards now show their
authenticated cover thumbnail and candidate metadata, and high-confidence
matches can be added directly to collection or wishlist; both matched and
needs-review candidates have direct list actions, while a "This isn't a
match" choice exposes new scan and manual-entry paths.

P3.1 Task 4 (quota headroom/admission and abandoned-upload cleanup) and
Task 6 (structured web request/error timing and correlation IDs) are
complete — see "Current state" for both descriptions. Two P3.1 checkboxes
remain unchecked: Task 5 (reconciling active-scan/batch/daily-attempt/
worker-concurrency defaults, queue-pressure pause/resume, and daily/spend
exhaustion behavior) is partially done — pause/resume and spend-exhaustion
behavior are already satisfied by Task 4's work, and the defaults
reconciliation itself is documented in `docs/OPERATIONS.md`, but batch
rollover is deliberately deferred to P3.2's continuous-capture state machine
rather than retrofitted here (see "Known gaps and risks") — and Task 7, the
persistent-spend inventory (`docs/ROADMAP.md`): reconcile development, both
retained Aurora data planes, storage/backups/logging, capped aggregate AI
usage, and declared staging/production activation hours against the
$25/month target, carrying known costs and unknowns into P3.5's reconciled
budget artifact. Task 7 is the more natural next slice to pick up (it needs
no new implementation decision the way Task 5's rollover does); after both,
P3.1 is fully complete and P3.2 (guided automatic mobile capture) is next per
`docs/ROADMAP.md`'s sequence. Pick up Task 5's batch rollover in P3.2 rather
than retrofitting it here unless the maintainer asks otherwise.

P3.3 is the first product scope cut if needed; its compatibility foundation
still precedes extraction. Phase 4 uses staging and retains explicit production
and Terraform-transfer gates. Do not default to resuming Phase 2 production
incident work.

Things worth knowing before extending this further:

- **`AUTH_MODE=production` is now verified against real Clerk test-mode
  keys and actually enforces route protection** — this was not true before
  this session amended ADR-0013 (see its "Amendment" section for the full
  root cause): `@next/env`'s `loadEnvConfig` silently returns a stale cache
  on any call after the first in a process unless `forceReload: true` is
  passed, so `AUTH_MODE`/`CLERK_SECRET_KEY`/the publishable key were all
  `undefined` inside `apps/web/src/proxy.ts` and `next.config.ts` at
  request time despite being set correctly in `.env` — `/dashboard`
  returned `200` unauthenticated instead of redirecting. Fixed by passing
  `forceReload: true` to both `loadEnvConfig` call sites
  (`next.config.ts`, `apps/web/src/server/context.ts`). Phase 2 removed the
  `next.config.ts` `env` block because it embedded the Clerk secret at build
  time. The container build sets only the non-secret auth mode, the root layout
  is forced dynamic, and ECS injects Clerk values when the standalone server
  starts.
  `apps/web/e2e/env.ts` now explicitly forces `AUTH_MODE=development` for
  the same reason: without that, a local `.env` with
  `AUTH_MODE=production` silently broke the entire e2e suite. Verified: a
  real protected-route redirect with genuine Clerk response headers,
  Clerk's real hosted `/sign-in` UI (screenshotted), and the full
  check/integration/e2e suite all still passing. **Not yet done**: actually
  signing up as a test user and confirming JIT provisioning creates a
  `users` row end-to-end — that's the next concrete step, not a full
  re-verification of the auth design.
- `clerk_user_id` is nullable with a placeholder backfill for existing rows
  (migration 011), deliberately not tightened to `not null` yet (see
  ADR-0013's Migration section) — do that tightening only after confirming
  real sign-in works, not before.
- **Never invoke `DELETE /account` (via curl, a browser, or otherwise)
  against real or shared dev data without meaning to delete it** — this
  session did exactly that by accident while checking response headers, and
  destroyed the local dev account's accumulated scan/library history (see
  "Current state" above). The repository-level integration tests
  (`schema.integration.ts`'s "account export and deletion" block) already
  exercise the full delete path safely against disposable throwaway users —
  prefer that over any manual `curl`/browser call against
  `DEVELOPMENT_USER_ID`'s real data.

Recently completed, for context:

- Account export and deletion (2026-08-31, ADR-0014, `docs/API.md`,
  `docs/SECURITY.md`): see "Current state" above for the full description.

- Production authentication (2026-08-31, ADR-0013, `docs/ARCHITECTURE.md`):
  see "Current state" above for the full description. Also installed Node
  22.23.2 via nvm-windows on this machine so `npm run check`/
  `test:integration`/`test:e2e` are runnable directly on Windows now, not
  only in WSL.

- Library search, sort, and CSV export (2026-08-31, ADR-0012, `docs/API.md`):
  new `LibrarySortSchema` (`recent`/`artist`/`title`) and `LibraryQuerySchema`
  (`packages/contracts/src/library.ts`) validate `list`/`q`/`sort` together.
  `listLibraryItemsForUser` (`packages/database/src/library-repository.ts`)
  gained optional `query`/`sort` params; a new `filterLibraryItemsByQuery`
  and an inline `sortLibraryItems` both operate on the already-serialized
  `LibraryItemResult[]` (the same effective artist/title the UI renders,
  which can come from a scan confirmation's JSONB override rather than the
  shared `albums` row) rather than pushing filtering into SQL — see ADR-0012
  for why. `GET /api/v1/library/route.ts` now parses `q`/`sort` through
  `LibraryQuerySchema`. New `GET /api/v1/library/export/route.ts` reuses the
  same query/repository call and serializes to `text/csv` with a
  `content-disposition: attachment` header and a small local `csvEscape`
  helper (no existing CSV utility in the codebase to reuse, and a single
  caller didn't justify a new `packages/domain` module). `library-page.tsx`
  now reads `searchParams` (Next.js 16's async page prop) and passes
  `query`/`sort` through; the previously non-functional search box and sort
  button were replaced by a new `"use client"` `library-toolbar.tsx`
  (debounced 300ms text input, a real `<select>` for sort, an "Export" link)
  that updates the URL via `router.replace` rather than fetching client-side,
  so the server component stays the single source of truth for the list.
  `collection/page.tsx` and `wishlist/page.tsx` now forward `searchParams`.
  Added contract tests for `LibraryQuerySchema` and one new database
  integration test covering artist-substring search, title-substring search,
  artist sort order, and a no-match case. Verified in WSL/Node 22.23.2:
  `npm run check` (61/61 unit tests), `npm run test:integration` (27/27),
  `npm run build` (26 web routes), `npm run test:e2e` (5/5 unchanged).
  Manually verified search/sort/export against real seeded data in a running
  WSL dev server (see "Current state" for detail); cleaned up the seeded rows
  afterward.

- Direct library item management (2026-08-31, ADR-0011, `docs/API.md`):
  `UpdateLibraryItemSchema` (`packages/contracts/src/library.ts`, drafted
  uncommitted by an earlier session and finished here) covers `{ list?,
notes? }`; a `copy` field was considered and dropped since a library item
  can have multiple copies and per-copy editing needs its own sub-resource
  (deferred, see Task above). `packages/database/src/library-repository.ts`
  gained `updateLibraryItem` and `deleteLibraryItem`, both row-locking the
  target item first: wishlist→collection creates one blank copy if none
  exist; collection→wishlist is rejected (`invalid_state`) while any copies
  exist; delete is rejected (`invalid_state`) whenever `scan_confirmations`
  references the item, since that table's `library_item_id` FK is `restrict`
  by design (protects the audit trail) and a naive delete would otherwise
  surface a raw Postgres FK violation on nearly every real item. New
  `PATCH`/`DELETE /api/v1/library/[itemId]/route.ts` follow the existing
  `parseUuid`/`parseJson`/`errorResponse` conventions. New client component
  `apps/web/src/app/library-item-actions.tsx` ("use client", fetch + `router.
refresh()`) adds "Move to collection"/"Move to wishlist"/"Remove" buttons to
  `library-page.tsx`'s server-rendered cards; "Move to wishlist" disables
  when `copyCount > 0` and "Remove" is hidden entirely when
  `confirmedFromScanId` is set, so the UI never offers an action the server
  would reject. Added contract tests (simplified schema) and five new
  database integration tests covering conversion, notes-only update, the
  copies-present rejection, cross-user rejection, and both delete outcomes
  (rejected with history, succeeds without). Verified in WSL/Node 22.23.2:
  `npm run check` (57/57 unit tests), `npm run test:integration` (26/26),
  `npm run build` (25 web routes), `npm run test:e2e` (5/5 unchanged).
  Corrected pre-existing `docs/API.md` drift: the library endpoint table
  listed `POST /library` as implemented, but no such route exists —
  `AddLibraryItemSchema` is contract-only.

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

- **Batch rollover is not implemented.** A capture session cannot yet span
  more than one batch: `/scan` still hard-caps a session at
  `MAX_SCANS_PER_BATCH` (20) records client-side (unchanged by P3.1 Task 4),
  so no session can reach the server's own 20-scan batch limit in normal
  use. This was a deliberate scope decision, not an oversight — see
  `docs/ROADMAP.md`'s P3.1 partial-progress note — because rollover's
  natural home is P3.2's always-armed continuous-capture state machine, not
  a retrofit onto today's one-shot upload picker.
- **P3.1 Task 4's quota-headroom polling has no Playwright coverage yet.**
  Verified by a scripted browser pass against a real dev server (see
  "Current state") and by database integration tests covering the headroom
  computation and early admission check directly, but nothing in
  `apps/web/e2e/` exercises the blocked-banner/disabled-button path (it
  would need a seeded user already at a quota limit, which the existing e2e
  fixtures don't set up). A regression here would not be caught in CI.
- **The worker side of the new `[worker] scan_analysis_timing` log
  (correlationId propagation and the storage-fetch/provider-call split) was
  not exercised against a real running worker or a live provider call.**
  It was verified indirectly: a database integration test confirms
  `prepareScanAnalysis` copies `job.correlationId` onto the `scan_attempts`
  row it creates, and the web-side correlation/timing logging
  (`[web] http_request`, `[web] upload_complete_timing`) was verified against
  a real running dev server. Nothing exercises `apps/worker/src/
analysis-handler.ts`'s new timing lines end to end with a real (or synthetic)
  identify call; a regression in the phase split or in reading
  `job.correlationId` off a real dispatched job would not be caught by any
  current test.
- **P3.1 Task 2's capture-session queue (`/scan`) has no Playwright coverage
  yet**, and two scope limitations worth knowing before extending it: the
  "N submitted so far" review-later link's counter is in-memory only and
  resets to zero on a refresh, so a returning user does not immediately see
  it even though earlier records in the same batch really did submit (the
  batch page itself is always authoritative — nothing is lost, the link is
  just not shown again until at least one more record submits in the new
  session); and a record that is rehydrated as "needs recapture" is labeled
  the same way whether its upload had actually reached the server or never
  started at all (it never had a chance to register partial server state in
  the latter case), which is accurate but slightly imprecise. Neither
  blocks P3.1 Task 4.
- **The `/library/{itemId}` detail page has no Playwright coverage yet.** Its
  behavior was verified by a scripted browser pass against a dev server (steps
  listed in "Current state") and by database integration tests, but nothing in
  `apps/web/e2e/` exercises it, so a regression would not be caught in CI. The
  natural home is a new spec covering collection card → detail → notes save →
  copy edit → remove; it needs library data seeded through the API rather than
  the `/scan` UI, since that flow is what currently times out locally.
- **`GET /api/v1/scans` likely throws on every real call.** Discovered this
  session while touching `listScanSummariesForUser`, not caused by it:
  `apps/web/src/app/api/v1/scans/route.ts` parses that function's output
  directly through `ListScansResponseSchema`, but `ScanListItemSchema`
  (`packages/contracts/src/scan.ts`) is `.strict()` and does not declare the
  `thumbnailImageId` field the repository has returned since the batch-card
  work (`docs/decisions/0007...`/batch thumbnails). No test exercises this
  route with real data — `scan.test.ts` has no coverage for
  `ListScansResponseSchema`/`ScanListItemSchema` at all — which matches this
  file's own earlier note that `.strict()` mismatches have slipped through
  unit/integration tests before and only surfaced via e2e. This route is not
  used by any current page (the dashboard and `/scans` both call
  `listScansForUser` directly as server components), so nothing in the app is
  visibly broken today, but any future client of this JSON endpoint will hit
  it immediately. Fix is small (add `thumbnailImageId` to `ScanListItemSchema`,
  or stop spreading the raw summaries into the response) but out of scope for
  the dashboard change that found it — see ADR-0017's consequences section.
- The Playwright e2e suite (`npm run test:e2e`/`test:e2e:matrix`) could not be
  used to verify the dashboard change on this machine: every project times out
  waiting for `/scan`'s "Start capture session" button across unrelated tests
  (`groups two front-cover photos...`, `identifies a misnamed cover photo...`,
  etc.), before ever reaching the dashboard assertions later in the same file.
  This session's changes never touch `/scan` or `capture-session.tsx`, so the
  timeout is very unlikely to be a regression from this work, but it was not
  re-verified against an unmodified tree to confirm that — consistent with
  this file's 2026-09-08 note that the local runner has had timing trouble
  with the standalone e2e server before. The dashboard
  add/dismiss behavior was instead verified manually against a running dev
  server with seeded data (see "Current state"). Whoever next needs real e2e
  coverage on this machine should investigate that timeout first; it blocks
  more than just this session's change.
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
- Production authentication (ADR-0013) has passed route-protection checks with
  real Clerk test-mode keys, but the Phase 2 production rehearsal still needs
  an end-to-end sign-up/JIT-provisioning run. `clerk_user_id` remains nullable
  with a placeholder backfill; no Clerk deletion webhook exists.
- AWS infrastructure, backups, observability, and delivery are implemented as
  code but have not yet been applied or rehearsed in the target account.
- `GET /usage` and `/account/usage` report a fixed rolling 30-day window
  with no pagination, custom range, or historical trend (ADR-0008,
  deliberate scope cut). `estimatedCostUsd` is `null` whenever no attempt
  in the window used a model present in `packages/domain`'s
  `MODEL_PRICING_USD`, which needs a manual update whenever provider
  pricing changes or a new model is adopted.

## Session log

- **2026-09-09 - Claude (continuing the same day).** Implemented P3.1's
  structured request/error timing and correlation-ID checkbox — see "Current
  state" for the full description. Every `apps/web` API route now shares one
  `withRoute` wrapper (`apps/web/src/server/http.ts`) for request timing,
  error handling, and a `[web] http_request` log line, replacing 20 routes'
  duplicated `createRequestId`/try-catch pairs; deliberately left
  `/api/healthz`/`/api/readyz` unwrapped as budget-conscious probe exceptions.
  An inbound `x-request-id` header is validated (`CorrelationIdSchema`, new
  `packages/contracts/src/common.ts`) and forwarded as an optional
  `correlationId` on `AnalyzeScanJobSchema` and a new nullable
  `correlation_id` column on `outbox_messages`/`scan_attempts` (migration
  013), so one trace value greps across the HTTP request, the queued job,
  and the worker attempt. Split previously-bundled timing into named phases
  via structured logs only (no new duration columns): the upload-complete
  route logs upload vs. normalization duration separately, and the worker's
  analysis handler logs storage-fetch vs. provider-call duration separately.
  Verified `npm run check` (95/95 unit tests, +11: 5 `CorrelationIdSchema`
  tests, 3 `AnalyzeScanJobSchema` compatibility tests, 3 new
  `parseCorrelationId` tests in a new `apps/web/src/server/http.test.ts`),
  `npm run build` (all 25 web routes present), `npm run test:integration`
  (34/34 database, +1), and a real isolated dev-server pass on port 3100 (the
  maintainer's own port-3000 server untouched; the scratch scan created
  during verification was deleted from the shared dev database afterward)
  confirming correlation-ID accept/drop behavior and the new
  `[web] upload_complete_timing` log against a real create-scan → upload →
  complete cycle. The worker side of the new timing/correlation logging was
  not exercised against a live analysis run — see "Known gaps and risks."
  Separately, at the maintainer's request, gave every phase/milestone
  checklist in `docs/ROADMAP.md` explicit, restarting-per-section `Task N`
  numbers (e.g. this session's work is P3.1 Task 6) so future references are
  unambiguous — this session had to ask the maintainer to disambiguate what
  "P3.1 Task 5" meant before starting, since `docs/HANDOFF.md`'s informal
  historical numbering did not line up 1:1 with the roadmap's checkbox order.
  Reconciled every numbered reference in this file's "Current state" and
  "Resume point" sections against the new canonical numbers (the
  quota-headroom work above is P3.1 Task 4, not "task 3" as earlier sessions
  called it; Milestone 4's accessibility work is Task 4, not "task 3").
  Session-log entries below are left as originally written, since they are
  historical record, not current state.

- **2026-09-09 - Claude.** Implemented P3.1 task 3: quota-headroom
  contracts/polling (`GET /api/v1/quota`), an early advisory admission check
  in `createOrGetScan`, and worker-driven abandoned-upload cleanup — see
  "Current state" for the full description. Refactored
  `enforceScanQuota` around a new shared `computeQuotaHeadroom` so the
  transactional (locked) and advisory (unlocked) quota reads cannot drift.
  Wired `/scan`'s capture session to poll headroom, show why capture is
  blocked, and never auto-retry a `quota_exceeded` failure. Documented the
  active-scan/batch/daily-attempt/worker-concurrency reconciliation and
  deferred batch rollover to P3.2 in `docs/OPERATIONS.md` and
  `docs/ROADMAP.md` (left task 3's second roadmap checkbox unchecked with a
  dated partial-progress note, since rollover itself isn't implemented).
  Verified `npm run check` (84/84 unit tests), `npm run build`,
  `npm run test:integration` (33/33 database), and a real isolated
  dev-server pass on port 3100 (the maintainer's own port-3000 server was
  never touched) confirming `GET /api/v1/quota` against real dev data and a
  scripted Playwright check of `/scan`'s unblocked state with zero console
  errors.

- **2026-09-08 - Codex.** Implemented P3.1 task 1, the `/scan`
  capture-session refactor. `CaptureSession` replaces the mode toggle with
  one upload-only control that creates independent cover-photo records, shows
  the session draft, and creates/submits independent scans incrementally under a single
  existing batch. A failed session reuses its batch, scan, upload, completion,
  and submit idempotency keys on retry. Updated scan-flow e2e coverage and
  API/roadmap/testing docs.
  Also corrected Playwright's standalone-web-server command (`next start` is
  incompatible with the app's standalone output). Verified focused Prettier,
  `npm run check` (79/79 unit tests), and web production build. The local
  runner reaches the standalone server but its 30-second command window
  terminates the browser suite before a test result; rerun `npm run test:e2e`
  in a normal terminal. No database migration or contract change.

- **2026-09-08 - Claude.** Outside-evaluation session; no code changed. The
  maintainer supplied a draft Phase 3-4 plan and asked for critique and
  suggestions, with clarity of goals and outcomes as the explicit lens and no
  changes forced where nothing better was available. Verified the draft's claims
  against the code rather than against the docs, and wrote
  `docs/PHASE_3_4_PLAN_REVIEW.md`: three errors (Phase 2 described as
  "delivered with tracked exceptions" when it is deliberately untagged with #8
  open; a $25/month target that does not compose with the existing $25
  production budget alarm, $10 development alarm, and
  `USER_MONTHLY_SPEND_LIMIT_USD` default of 20; and "reuse existing batch
  grouping" understating P3.1, since the server genuinely supports incremental
  batch membership but `scan/page.tsx` is a 708-line one-shot form), eleven
  gaps, and an exit-criteria replacement table. Confirmed several things worth
  recording independently of the review: batches accept incremental scans with
  no schema or API change (`createOrGetBatch` takes no scan list);
  `USER_ACTIVE_SCAN_LIMIT` (20) exactly equals `MAX_SCANS_PER_BATCH` (20) while
  `ANALYSIS_CONCURRENCY` defaults to 1, so a full capture session sits at the
  quota ceiling and quota is only checked at submit, after upload and `sharp`
  normalization are already paid for; there is no Redis or ElastiCache in any
  AWS root, so a shared discovery cache has no substrate; and the Playwright
  suite selects capture controls by `input[type="file"]:not([capture])`, which a
  live-camera surface would break in four places. Updated this file's Current
  state and Resume point; deliberately did **not** touch `docs/ROADMAP.md`, file
  GitHub issues, or change any Phase 2 status. Verified with `npm run check`.

- **2026-09-07 - Claude (second session).** Picked up the prior session's
  uncommitted `USER node` → `USER 1000:1000` Dockerfile fix (for the
  `runAsNonRoot` numeric-UID bug). Ran `npm run check` clean, committed
  (`fa997f8`), pushed, and confirmed staging failed once
  (`34156798043`, a fourth distinct bug: `CannotPullContainerError` on the
  worker image immediately after a freshly-provisioned NAT gateway, before it
  was routing ECR pulls) then passed clean on retry after fixing it
  (`beeb98a`: retry the ECS migrate task launch on a pull-specific failure,
  `scripts/aws/run-worker-command.sh`). With the maintainer's explicit
  confirmation, dispatched production for `beeb98a`
  (`34160436572`) — it cleared EKS provisioning, Kubernetes Secret
  propagation, `runAsNonRoot`, migration, and Kubernetes deployment for the
  first time ever, but failed "Smoke test CloudFront path" with a persistent
  504 (root cause not found; filed as **#8**).
  That run's own 61-minute duration then exceeded the GitHub OIDC role's
  default 1-hour AWS session, so its automatic failure cleanup died mid-destroy
  with `ExpiredToken`, leaving a live, undestroyed production runtime (EKS,
  ALB, CloudFront, WAF, NAT) and an orphaned Terraform state lock — while the
  SSM `active` flag had already (mis)reported `false`, causing two automated
  deactivation attempts to silently no-op. Diagnosed live with the
  maintainer's help confirming real AWS Console state (the logs alone were
  not trustworthy here — this is itself worth remembering). Fixed the masked
  SSM-read failure path (`b2e0d5f`), added emergency `skip_activation_check`
  and `stale_lock_id` workflow_dispatch inputs (`69854cb`, `57e6a3e`) to
  bypass the wrong gate and clear the orphaned lock, and successfully tore
  down the remaining 5 resources (`34165576307`) — the maintainer confirmed
  via the Console that everything (EKS/ALB/CloudFront/WAF/NAT) is gone;
  Aurora and the VPC foundation remain by design. Filed the session's two new
  bugs as **#9** (OIDC session duration) and **#10** (review the emergency
  bypass inputs). Also confirmed staging's own deactivation for `beeb98a` was
  already clean and unaffected.
  At the maintainer's direction, stopped pursuing further production
  activation attempts in-session and instead converted all remaining Phase 2
  work into GitHub issues (**#8–#15**, including a maintainer-requested
  tagging-standardization issue, **#11**) so nothing depends on this file's
  memory alone. Documented the existing AWS tagging convention and its gaps
  in `docs/OPERATIONS.md` (`47c3123`). Checked off P2.3's "review real
  plans and apply inactive foundations" item (now genuinely satisfied by this
  session's repeated successful foundation applies). Rewrote this file's
  Resume point to reflect the maintainer's stated intent to move toward Phase
  3 now that development is stable, rather than continuing Phase 2
  automatically. Did not create a git tag — Phase 2 is deliberately being
  left incomplete-but-tracked rather than declared done.

- **2026-09-07 - Claude.** Continued from the prior session's AMI-fix
  handoff, with the user's goal of closing out Phase 2 (P2.1–P2.6) in
  `docs/ROADMAP.md`. Fixed a Prettier formatting break in `docs/HANDOFF.md`
  (commit `413fc5f`) that failed CI on the AMI-fix push. With the user's
  explicit approval, ran `scripts/configure-github-repository.sh` against the
  live repository — applied branch protection and security settings
  (secret scanning/push protection, vulnerability alerts, automated security
  fixes, private vulnerability reporting, read-only default workflow
  permissions, labels), verified live via the GitHub API. Confirmed two
  consecutive staging lifecycle runs passed in full (`34080493765` for
  `506767e`, `34081530170` for `413fc5f`), checked off the corresponding
  `docs/ROADMAP.md` items for P2.1 and P2.4. Split P2.1's fork-gate item into
  its own still-open checkbox (an untrusted fork PR rehearsal, distinct from
  the config script).

  Dispatched production activation three times to verify the AMI fix and
  demonstrate the EKS runtime end to end (P2.2). Each attempt failed on a
  different, genuine bug, in order: (1) `34041389496` failed at "Verify
  runtime secrets" — self-resolved on the next attempt once secrets were
  consistently readable, not a real bug; (2) `34145509904` cleared EKS
  provisioning (confirming the AMI fix works) but failed "Migrate database"
  with `CreateContainerConfigError` — root-caused to a Kubernetes Secret
  being read by a migrate Job 6ms after creation, before EKS API-server
  propagation; fixed in commit `5c098b6` (poll for readability before
  creating the Job; upgraded failure diagnostics from bare `kubectl logs`,
  which is empty when a container never starts, to `describe job`/
  `describe pods`/`logs --all-containers`); staging re-verified clean on this
  commit before redispatching; (3) `34153511737`, with both fixes in place,
  cleared EKS provisioning _and_ the secret-propagation race (the readiness
  poll found the ConfigMap/Secret immediately) but failed "Migrate database"
  again on a third, distinct cause, this time fully captured by the new
  diagnostics: `runAsNonRoot: true` in all three production pod specs
  requires a numeric UID to verify statically, but both `Dockerfile.web` and
  `Dockerfile.worker` set `USER node` by name. Staging never exercised any of
  these three bugs because it deploys via ECS, not Kubernetes — this was the
  first true end-to-end run of the production EKS code path. Drafted the fix
  (`USER node` → `USER 1000:1000` in both Dockerfiles) but ran out of runway
  to build/check/commit/push/re-verify-through-staging/redispatch within this
  session; **left uncommitted in the working tree** along with the already-
  correct P2.1/P2.4 `docs/ROADMAP.md` edits from earlier in the session. Full
  detail and exact next steps are in Current state and Resume point above.
  Did not touch `docs/ROADMAP.md`'s P2.2/P2.3 checkboxes (production has not
  yet succeeded end to end) and created no git tag, per the user's explicit
  requirement to confirm before tagging.

- **2026-09-06 - Claude.** Reviewed GitHub Actions run history and live AWS
  state (via `gh`/`aws` CLI in WSL) to reconcile the maintainer's report of a
  failed staging pipeline against the documented state. Found that the staging
  failure they saw, run `34038709907`, predates commit `fd99943`'s teardown
  retry fix by 32 minutes and is already resolved: the very next staging run
  after that fix, `34040437776`, hit the same transient EIP/ENI race but
  retried automatically and passed the full lifecycle, matching what
  `docs/HANDOFF.md` already recorded. The real open failure was newer than the
  existing handoff entry: two "Deploy production demo" runs
  (`34041389496`, `34042087635`) ran after production secrets were populated.
  The first failed at "Verify runtime secrets"; the second got through
  cluster/ALB/CloudFront/Route 53 creation and failed provisioning the EKS
  node group on an ARM64/x86 AMI-type mismatch (`t4g.medium` instance type
  with a defaulted `AL2023_x86_64_STANDARD` AMI). Confirmed both runs' failure
  cleanup left no dangling EKS cluster, load balancer, or CloudFront
  distribution in the account, only the persistent foundation
  (`environment_active` is designed to retain that). Fixed by pinning
  `ami_type = "AL2023_ARM_64_STANDARD"` on `aws_eks_node_group.main`
  (`infra/terraform/production/eks.tf`), matching the ARM64 architecture used
  everywhere else in the platform. Verified: `terraform fmt`/`validate` pass
  for all four roots (reinitialized the local production provider cache,
  which had gone stale), and `npm run check` passes (79/79 tests, lint,
  typecheck, formatting). Did not commit or dispatch a new production run;
  left both for the maintainer's review per session norms around
  outward-facing/hard-to-reverse actions.

- **2026-09-06 - Codex.** With explicit maintainer approval, copied the ignored
  local development/test Clerk secret, Clerk publishable key, and OpenAI key to
  the corresponding staging Secrets Manager containers without printing their
  values. Staging run `34038709907` then passed foundation reconciliation,
  migrations, both ECS service stability gates, both smoke endpoints, and
  immutable image promotion. The final teardown failed on an AWS
  eventual-consistency race releasing a NAT EIP after its ENI disappeared.
  Added one bounded three-attempt Terraform apply helper and used it for staging
  deactivation, production failure cleanup, and scheduled/manual production
  deactivation. Retry commit `fd99943` reused the already tested image digests;
  staging run `34040437776` passed the complete lifecycle, including teardown.
  Production run `34041389496` then created the persistent production
  foundation but stopped at the intended provider-secret gate. EKS provisioning
  was skipped and cleanup succeeded, leaving production inactive. Separate
  maintainer approval is required before reusing staging's development/test
  provider values in production.

- **2026-09-06 - Codex.** Dispatched the first fully configured staging workflow
  for `c17a83e`; OIDC authentication and the cost preflight passed, but immutable
  ECR correctly rejected overwriting the web image tag already published by the
  development workflow. An initial reuse fix still raced when both workflows
  preflighted a missing image concurrently, so that staging retry was cancelled
  before Terraform. Updated staging delivery to publish and reuse isolated
  `<sha>-staging` tags, build missing images only, make
  `staging-passed-<sha>` promotion idempotent with digest conflict detection,
  and avoid deactivation before state initialization. Production has not been
  dispatched because no commit has passed a complete staging lifecycle yet.
  Run `34037617340` then proved the isolated tags work, initialized state, and
  created the staging foundation before the expected missing-provider-secret
  gate stopped activation. Deactivation succeeded. All three source values are
  present in the ignored local `.env`, but copying those development/test
  credentials to staging requires explicit maintainer approval.

- **2026-09-05 - Codex.** Replaced
  `scripts/configure-github-repository.ps1` with an equivalent Bash
  script and updated both documented invocations. The Bash version uses strict
  error handling, preserves the public-repository guard and all prior settings,
  and accepts the repository as an optional first positional argument. A guard
  validation discovered the repository had become public and that GitHub now
  rejects the old script's redundant explicit Advanced Security field with
  HTTP 422; removed that field while preserving secret scanning and push
  protection. The failed first PATCH stopped the strict script before any later
  security endpoint, label, workflow-permission, or branch-protection call.
  Read-only follow-up confirmed branch protection and the remaining security
  endpoints are still disabled. The conversion also adds the Lambda-worker
  container job to required status checks; the older PowerShell script predated
  that third Platform matrix job. `bash -n`, `npm run check` (79/79),
  `npm run build`, and `git diff --check` pass. ShellCheck is not installed
  locally.

- **2026-09-05 - Codex.** Audited every outstanding P2.1-P2.4 roadmap item
  against committed implementation, GitHub configuration/runs, and read-only
  AWS inventory. Split the stale aggregate checklist entries to record clean
  Gitleaks, the live development Lambda deployment, target-account bootstrap,
  development state, and GitHub environment creation accurately. Added
  `docs/PHASE_2_MILESTONE_REVIEW.md` with the ordered manual visibility/fork,
  runtime, foundation-apply, and two-lifecycle staging checklist. Found that
  staging/production variables are absent, repository plan values contain
  invalid placeholders, only development remote state/Lambdas exist, no
  ECS/EKS clusters exist, and staging's successful runs are configuration
  skips. Also corrected the previous UI commit's accidental inclusion of a
  downloaded AWS CLI bundle: removed its three files from Git while preserving
  the local bundle, ignored `/aws/` in Git/Docker, and ignored local Terraform
  state in Prettier. `npm run check` passes all 79 tests plus formatting, lint,
  and typecheck; `npm run build` and `git diff --check` pass. No infrastructure
  was changed and no live AI call was made.

- **2026-09-05 - Codex.** Reviewed the frontend, ranked ten improvements before
  editing, and completed the first eight low-risk items in `docs/UI_UX_REVIEW.md`.
  Fixed the hidden mobile scan links with whole-row links; improved shared
  control sizes, contrast, focus, wrapping, and safe-area spacing; kept full
  photo edges in previews; collapsed optional copy details; clarified candidate,
  upload, catalog-empty, and save feedback; added clear-search recovery. Fixed
  queued scans initializing empty review drafts and retry not restarting polling.
  Preserved Next.js, global CSS, API payloads, backend behavior, and dependencies.
  Browser coverage now exercises queued-to-result form initialization, retry
  polling (stubbed retry, no extra analysis), empty catalog feedback and review
  accessibility, collapsed values, mobile scan navigation, clear-search sorting,
  upload focus, and 360px layout. Windows WebKit skips links in its default Tab
  order (reproduced on a minimal page), so the shared keyboard smoke test uses
  collection, which includes a search input. All 56 matrix checks and 79 unit
  tests pass, as do lint/typecheck/build and changed-file formatting. Full
  `npm run check` still stops at the same three unrelated formatting failures
  found before edits: `aws/README.md`, `infra/terraform/bootstrap/terraform.tfstate`,
  and its `.backup`. These files were untouched. Inspected local phone scan,
  full-image preview, review, and desktop dashboard screenshots. Compose services
  were started for the isolated e2e database/queue and remain running; the test
  server/worker stopped normally. No live AI calls, deployment, commit, or push.
  Real cover thumbnails, batch navigation, and copy-editor error handling are
  separate follow-ups. The generated Next type imports were restored by the
  final normal build.

- **2026-09-05 - Codex.** Replaced the local-only development database secret
  with the maintainer-provided Supabase session-pooler endpoint on IPv4 port 5432. Repaired a malformed missing query delimiter without exposing the
  credential, retained `sslmode=require`, removed unsupported
  `channel_binding=require`, and verified both database reachability and
  client-side TLS negotiation with `psql`. Extended the deployment workflow's
  database guard to reject URLs that do not explicitly require TLS. Deployment
  run `34001697979` then failed because the web Lambda was accidentally deleted
  between Terraform reconciliation and secret injection. Fresh-SHA run
  `34002332466` recreated it and reached the migration, which exposed Node
  `pg`'s temporary interpretation of `sslmode=require` as `verify-full` and its
  rejection of the Supabase certificate chain. Added `uselibpqcompat=true` to
  the stored URL so `require` retains standard libpq semantics (mandatory
  encryption without certificate verification), then successfully applied all
  11 repository migrations to Supabase. Final deployment run `34002645203`
  passed image builds, both Terraform applies, secret injection, idempotent
  migration confirmation, API/event trigger activation, and its HTTP smoke
  test. Independently verified `/api/healthz` returns `status: ok` and
  `/api/readyz` returns `status: ready` at
  `https://dev-vh.siliconforest.io`.

- **2026-09-05 - Codex.** Platform run `33995480727` passed all Terraform,
  Kubernetes, three-image build/scan, and SBOM jobs after the expiring Trivy
  waiver. Development run `33995480784` then successfully created both Lambda
  functions, the full `dev-vh.siliconforest.io` certificate/DNS resources, and
  the rest of the first-apply stack, proving the hostname and image-manifest
  fixes; it stopped safely before triggers because secret containers had no
  values. With explicit maintainer authorization, copied the four existing
  `.env` values directly to AWS Secrets Manager without logging them and
  verified one `AWSCURRENT` version per secret. Redeploy commit `44c4ec3`
  successfully loaded and injected all secrets, but migration failed because
  the local `DATABASE_URL` resolves to `host.docker.internal`, which GitHub and
  AWS cannot reach. Triggers remain disabled. Added a workflow guard that
  rejects local-only database hosts with an actionable error. An external TLS
  PostgreSQL URL is the sole blocker to completing migration, trigger enablement,
  and live HTTP smoke tests.

- **2026-09-05 - Codex.** Diagnosed development deployment run `33991720573`:
  GitHub obtained an OIDC token, but AWS rejected it before builds or Terraform.
  CloudTrail showed the actual subject as the stable-ID form
  `repo:jessig1@13804284/vinylhound_new@1345526931:environment:development`,
  while bootstrap trusted the legacy name-only prefix. GitHub's OIDC
  customization API confirmed that stable prefix. Updated bootstrap plan and
  environment trust policies to use the exact prefix and documented how forks
  retrieve and override it. Applied the bootstrap update to the existing
  `vinylhound-tf` state: all four GitHub IAM roles changed in place with no
  resources created or destroyed, and the next deployment authenticated
  successfully.

- **2026-09-05 - Codex.** Continued development deployment run `33991720573`
  through three attempts. Corrected the development ECR variables from bare
  names to full account/region repository URLs, after which both runtime images
  built and pushed successfully. The first Terraform apply then exposed two
  configuration defects: `APP_HOSTNAME=dev-vh` was not an ACM-compatible FQDN,
  and Buildx's attached attestations produced image indexes unsupported by
  Lambda. Corrected the live hostname to `dev-vh.siliconforest.io`; added an
  early workflow hostname guard and matching Terraform validation; and disabled
  attached provenance/SBOM metadata for the two development Lambda images.
  Standalone SBOM generation remains in the platform CI workflow. The patched
  development Terraform root validates with Terraform 1.13.3, and affected
  YAML/Markdown files pass Prettier. Pushed these corrections as `a8b2bec`; its
  deployment run was subsequently cancelled due to the platform finding below.

- **2026-09-05 - Codex.** Platform run `33994598016` correctly blocked the
  worker-Lambda image on HIGH-severity `CVE-2026-14456`: the pinned AWS Lambda
  Node.js 22 arm64 base contains OpenSSL `3.5.7-2.amzn2023.0.1`, while Trivy
  reports `.0.2` as fixed. AWS's current `nodejs:22` arm64 tag still contains
  `.0.1`, and `dnf upgrade` against the image's repositories reports no update
  available. Cancelled concurrent deployment run `33994597990` before it could
  activate that image. Added a single-CVE Trivy waiver expiring 2026-10-05 and
  explicitly wired it into the platform scan. A local Trivy 0.70 scan of the
  rebuilt arm64 image then passed with zero unsuppressed HIGH/CRITICAL findings.
  Remove the waiver and update the pinned Lambda base digest as soon as AWS
  publishes the fixed package.

- **2026-09-05 - Codex.** Added Terraform bootstrap validation for S3 state
  bucket naming after AWS rejected the maintainer's underscore-containing
  `vinylhound_tf` value. The bootstrap README now gives a valid hyphenated,
  globally unique account-ID example, so future invalid names fail locally
  before an AWS create request.

- **2026-09-05 - Codex.** Diagnosed the maintainer's repeated Terraform 1.8.4
  bootstrap error as WSL resolving `/usr/bin/terraform` while Windows had the
  newly installed 1.13.3 package. Downloaded the official Linux 1.13.3 archive,
  verified it against HashiCorp's published SHA-256 checksum, and installed it
  at `/usr/local/bin/terraform`, ahead of `/usr/bin`. The maintainer's exact
  bootstrap init now succeeds in WSL and `terraform validate` passes. Retained
  the Linux AWS-provider package hash that WSL added to the bootstrap lock;
  removing it correctly caused cached-package verification to fail. Windows
  1.13.3 formatting/validation passes for all four roots, and the milestone's
  GitHub Linux Terraform validation job also passed. Parallel extra-root WSL
  initialization hit NTFS provider-cache I/O errors, so do not share a
  `.terraform` provider directory between Windows and WSL when revalidating.

- **2026-09-05 - Codex.** Built and locally smoke-tested all three runtime
  images. The first build exposed an invalid variable-based `COPY --from` in
  `Dockerfile.web`; a named Lambda-adapter stage fixes it. The Lambda worker
  also ran as root locally and retained npm, so its final stage now removes
  package-manager tooling and selects UID/GID 65534. The final top-level
  `npm run container:build` succeeds. Web returned 200 for liveness, readiness,
  and `/`, reached Docker `healthy`, ran as UID 1000 without npm, and contained
  an executable Lambda adapter. The worker applied all 11 migrations to an
  isolated database, produced a fresh heartbeat, ran as UID 1000 without npm,
  and completed SIGTERM shutdown with exit code 0. The Lambda image cold-started
  locally as UID 65534 without npm, returned zero EventBridge publications from
  an empty database, and returned the expected partial-batch failure for an
  invalid SQS record. OpenAI was disabled or replaced by a non-real placeholder;
  disposable databases/containers were removed and Compose dependencies were
  returned to their initially stopped state. The maintainer authorized this
  verified redesign for an infrastructure milestone commit and push before the
  real AWS plan gate.

- **2026-09-03 - Codex.** Resumed an interrupted, uncommitted AWS platform
  redesign and completed its repository implementation. Added the development
  Lambda/API Gateway/SQS root, production EKS/CloudFront/WAF/SQS root and
  Kubernetes workloads, SQS queue adapter/tests, production expiry teardown,
  worker migration and Lambda entrypoints, and worker shared-package runtime
  compilation for hardened images. Corrected Terraform syntax/state-address
  compatibility, Lambda visibility timeout, CloudFront-origin networking, EKS
  Pod Identity/observability, and workflow manifest validation. Recorded the
  design in ADR-0016 and synchronized operational, architecture, security,
  testing, roadmap, API, and repository documentation. Checks, builds,
  actionlint, kubeconform, and all four Terraform validations pass. A final
  container build attempt reached Docker but its daemon reported that Docker
  Desktop was unable to start, so Docker runtime verification and real AWS
  plans remain the next gates.

- **2026-09-02 - Codex.** Pushed `a8bdff5` (`fix pre-activation pipeline
failures`) and verified the resulting GitHub Actions runs: CI, Security,
  staging, Terraform validation, and both container build/Trivy/SBOM jobs all
  completed successfully. The only intentionally skipped jobs were CodeQL and
  SARIF publication until the repository becomes public, the AWS plan absent a
  trusted pull request, and deployment work absent environment configuration.

- **2026-09-02 - Codex.** Diagnosed the first GitHub Actions runs after Phase 2
  delivery using authenticated read-only API/log access. CI and Terraform
  validation passed; Gitleaks itself was clean. Corrected private-repository
  CodeQL/SARIF upload handling, activation guards and environment-variable
  loading for staging/deactivation/production, and removed unused npm/corepack
  from final runtime images to eliminate Trivy's inherited critical findings.
  Local workflow formatting, `npm run check` (73 tests), and `npm run build`
  pass. Push the follow-up and require clean CI, Security, and Platform runs.

- **2026-09-02 - Codex.** Ran `npm run check` (73 tests) and `npm run build`
  successfully, then committed and pushed the complete Phase 2 implementation
  to `main` as `f29016e` (`add Phase 2 public deployment platform`). The next
  maintainer action is to review the resulting GitHub CI, Security, and
  Platform workflow results before the visibility-change gate.

- **2026-09-02 - Codex.** The maintainer rotated the historical Gemini key and
  deleted its sole containing branch, `experiment/gemini-vs-openai`. A local
  ref audit and GitHub `ls-remote` verification confirmed that neither local
  nor remote branches contain the exposing commit; `main` was never affected.
  Updated the Phase 2 activation sequence to require a clean Gitleaks workflow
  run, then public visibility and repository-settings automation (the script
  itself refuses private repositories).

- **2026-09-02 - Codex.** Implemented VinylHound Phase 2 at repository level:
  public-repository governance, runtime/container hardening, task-role/default
  AWS credentials, TLS/pool configuration, worker drain/reconciliation and
  metrics, Terraform bootstrap plus isolated JIT environments, GitHub OIDC
  delivery/cleanup workflows, cost/security/scaling/observability controls,
  ADR-0015, and synchronized platform documentation. Hardened the result during
  verification by splitting web/worker execution-secret roles, adding a real
  worker heartbeat and shutdown ordering, excluding Terraform providers from
  container contexts, adding trusted internal-PR plans, serializing deployment
  and expiry workflows, and provisioning runtime/migrating before ECS service
  rollout. `npm run check` (73/73), `npm run build`, actionlint, and both
  Terraform validates pass. Local Docker image verification is outstanding
  because Docker Desktop's daemon became unresponsive. The required redacted
  full-history audit found a real historical Gemini credential matching the
  ignored local `.env`; public visibility is explicitly blocked pending
  rotation and an approved coordinated history rewrite. Nothing was applied to
  GitHub or AWS, committed, pushed, or made public.

- **2026-08-31 - Codex.** Replaced the dashboard shell's fixed Collection
  (`48`) and Wishlist (`12`) navigation badges with per-user database counts
  fetched by the server layout. `npm run typecheck` passes.

- **2026-08-31 - Codex.** Added a public `/privacy` notice linked from the
  landing page, and implemented per-copy `PATCH`/`DELETE` endpoints with
  ownership checks, parent-item locks, and collection-page controls for copy
  location, acquisition date, notes, and deletion. The remaining private AI
  evaluation cannot safely run yet: the private 52-case manifest exists and
  an API key is configured, but zero cases meet its required maintainer
  verification/consent readiness gate. No billable calls were made. `npm run
typecheck` passes.

- **2026-08-31 - Codex.** Audited `docs/ROADMAP.md` at the maintainer's
  request and replaced the dashboard's hard-coded `data.ts` content with live,
  authenticated database reads: three latest scans, collection/wishlist
  previews, and exact server-side item counts. Replaced the fixed date and
  boilerplate labels with current or data-derived content and added explicit
  empty states. The audit confirmed the roadmap still explicitly defers a
  published privacy notice, per-copy editing/deletion, and the private AI eval
  baseline; it is therefore not fully complete. `npm run check`, `npm run
build`, and `git diff --check` pass. Changes are uncommitted and coexist
  with unrelated existing working-tree changes.

Newest first. One entry per agent session: date, agent, what changed, what was
decided.

- **2026-08-31 - Codex.** Added GitHub security automation. The new Security
  workflow runs CodeQL, a full-history/redacted Gitleaks scan with SARIF upload,
  and pull-request dependency review; all are visible Action runs and status
  checks, while CodeQL/Gitleaks alerts appear in the Security tab. Added weekly
  npm Dependabot configuration and documented the repository settings/branch
  protections a maintainer must enable. No GitHub settings were changed because
  this workspace has no repository-administration credential.

- **2026-08-31 - Codex.** Implemented the skipped Milestone 4 operations
  slice. Added `docs/OPERATIONS.md`, production service/backup/monitoring and
  alert guidance, public liveness/readiness probes, structured worker startup
  and outbox-publish logs, and the `ops:restore-test` command. The restore
  drill passed against the local Compose Postgres service and cleans up only
  its dedicated `vinylhound_restore_verification` database and temporary dump.
  Added transactional per-user daily analysis, active scan, and rolling spend
  protections (with active-job cost reservation) before outbox submission and
  retry; quota failures are HTTP 429. Added config coverage and a database
  integration quota test. `npm run check` passed (71 unit tests),
  `npm run test:database` passed (26 integration tests), and the restore drill
  passed. No cloud provider resources were provisioned because no provider
  account, region, or deployment authority was supplied.

- **2026-08-31 - Codex.** Implemented Milestone 4 task 3: added axe-core
  WCAG 2 A/AA checks for the main authenticated routes and a keyboard-focus
  e2e check; added visible focus, skip navigation, reduced-motion behavior,
  explicit alert semantics, and a label for the destructive-confirmation
  input. Expanded Playwright into mobile Chromium (fast default), desktop
  Chromium, desktop Firefox, and mobile WebKit; `test:e2e:matrix` runs all
  profiles. Installed Firefox/WebKit locally. `npm run check` passes (69/69).
  The local e2e/matrix run could not start because this Windows session's
  Node 22 began failing `os.userInfo()` with `uv_os_get_passwd` `ENOMEM` while
  the synthetic e2e worker starts; this is environment-level (a direct
  `node -e` reproduces it), not an assertion failure. Preserve the existing
  uncommitted Clerk redirect edits in the sign-in/sign-up pages when committing
  this work.

- **2026-08-31 - Claude (fifth session, same conversation).** At the
  maintainer's request, wired real Clerk test-mode keys into `.env` to
  finally exercise `AUTH_MODE=production` for real — and found that it
  didn't work: `/dashboard` returned `200` unauthenticated instead of
  redirecting to `/sign-in`. Root-caused it to `@next/env`'s `loadEnvConfig`
  silently returning a stale cache on any call after the first in a process
  unless `forceReload: true` is passed; Next.js's own internal call (scoped
  to `apps/web`, no monorepo-root `.env`) runs first and poisoned the cache
  for both of this repo's own `loadEnvConfig` calls
  (`next.config.ts`, `apps/web/src/server/context.ts`), so `AUTH_MODE`/
  Clerk's keys were `undefined` at request time despite being set correctly
  in `.env` — reproduced and confirmed the exact mechanism with a standalone
  Node script before touching any code. Fixed both call sites with
  `forceReload: true`, and added a `next.config.ts` `env` block so Edge
  middleware's separately-compiled bundle (which never executes
  `next.config.ts`'s `loadEnvConfig()` at request time) gets the values
  statically inlined. Also fixed `apps/web/e2e/env.ts`, which broke as a
  direct consequence: e2e's tests navigate straight to protected routes with
  no sign-in step, so once `AUTH_MODE=production` actually worked, a local
  `.env` set to `production` (as it now is, for this verification) started
  failing the entire e2e suite by redirecting every test to `/sign-in`;
  fixed by forcing `AUTH_MODE=development` explicitly in the e2e env
  builder rather than inheriting whatever `.env` has. Verified with real
  Clerk keys: `/dashboard` correctly redirects with genuine Clerk auth
  headers, `/sign-in` renders Clerk's real hosted UI (screenshotted), and
  `npm run check` (69/69)/`test:integration` (33/33)/`test:e2e` (5/5) all
  still pass. Documented the full root cause as an amendment to ADR-0013
  rather than a new ADR, since it corrects a claimed-but-unverified
  behavior rather than changing the design. Also declined to run a
  pasted Clerk-CLI setup skill against this repo (would have re-scaffolded
  over the existing hand-built integration) after confirming with the
  maintainer it wasn't the intended path. Uncommitted; the maintainer
  should review before commit.

- **2026-08-31 - Claude (fourth session).** Committed and pushed task 1
  (production authentication, `9507cad`) at the maintainer's request, then
  completed Milestone 4 task 2, account export and deletion (ADR-0014).
  Investigated the schema first and found a real design problem before
  writing any code: `scan_confirmations.library_item_id`/`.release_id` are
  deliberate `restrict` FKs (ADR-0011) that would make a plain cascading
  delete of a `users` row fail with a foreign key violation, since Postgres
  does not guarantee `scans` cascade before `library_items` is touched in
  the same operation. Confirmed the resolution with the maintainer (delete
  `scan_confirmations` directly first, in the same transaction, rather than
  soft-delete/anonymize) and confirmed export scope (metadata-only JSON, no
  image bytes) before implementing either. New `packages/database/src/
account-repository.ts` (`getAccountExportForUser`, `deleteAccount`) and
  `packages/contracts/src/account.ts`; new `GET /api/v1/account/export` and
  `DELETE /api/v1/account` routes; a new "Your data" section on `/account`
  with a type-to-confirm delete flow, verified end-to-end with a scripted
  Playwright check (button stays disabled until the exact phrase is typed)
  and a screenshot. Added 4 new database integration tests (export,
  export-not-found, delete-with-restrict-fks-and-shared-catalog-preserved,
  delete-not-found) and 4 new contract tests. Verified: `npm run check`
  (69/69 unit tests), `npm run test:integration` (33/33), `npm run build`
  (30 routes, +2), `npm run test:e2e` (5/5). **Made a real mistake while
  manually verifying the delete route**: a `curl -X DELETE` intended only to
  inspect response headers executed for real against the local dev
  database's `DEVELOPMENT_USER_ID` account, destroying its accumulated
  scan/image/library history from every prior session's manual testing (a
  fresh empty row was auto-reprovisioned under the same ID, so the app still
  works). Disclosed this to the maintainer immediately; confirmed the local
  data did not need recovering. Updated `docs/API.md`, `docs/SECURITY.md`
  (the retention policy is now stated concretely instead of describing a
  future gap), `docs/ROADMAP.md`, and this file. Uncommitted; the maintainer
  should review before commit.

- **2026-08-31 - Claude (third session).** Started Milestone 4 (checked with
  the maintainer first, since the roadmap only listed broad areas, not
  discrete tasks) and completed task 1, production authentication
  (ADR-0013). Confirmed the approach with the maintainer at each expensive-
  to-reverse decision point before implementing: hosted identity provider
  over self-hosted Auth.js, Clerk specifically, Clerk's default hosted
  `<SignIn>`/`<SignUp>` UI over reproducing the app's bespoke fake auth
  form, and keeping the existing landing page (stripped of its fake-session
  logic) rather than redirecting `/` straight to `/sign-in`. Added
  `users.clerk_user_id` (migration 011, nullable with a placeholder
  backfill), `getOrCreateUserIdByClerkId`, a `requireUserId` helper
  replacing every route/page's `DEVELOPMENT_USER_ID` read, and
  `apps/web/src/proxy.ts` (Next.js 16's Proxy convention) for route
  protection. `AUTH_MODE` widened from a literal to a real
  `development`/`production` switch; a `NEXT_PUBLIC_AUTH_MODE` mirror lets
  client components branch without a `<ClerkProvider>` in development mode.
  The Playwright e2e run caught a real bug before commit: the first version
  of the proxy gated Clerk logic from _inside_ `clerkMiddleware()`'s
  callback, but `clerkMiddleware()` itself throws at construction time
  without a publishable key, hanging every request in development mode;
  fixed by only constructing `clerkMiddleware()` at all when
  `AUTH_MODE=production`, exporting a plain pass-through otherwise. Also
  installed Node 22.23.2 via nvm-windows on this machine (previously only
  v20.17.0, which fails this repo's `--env-file-if-exists` usage) so
  `npm run check`/`test:integration`/`test:e2e` now run directly on Windows.
  Verified: `npm run check` (65/65 unit tests, 4 new), `npm run
test:integration` (29/29, 2 new), `npm run build` (28 routes, +2), and
  `npm run test:e2e` (5/5, run in development mode — production mode's
  Clerk path was verified statically, not against a real account; see
  Resume point). Uncommitted; the maintainer should review before commit.

- **2026-08-31 - Claude (second session).** Completed the remaining half of
  Milestone 3 task 3: library search, sort, and CSV export (ADR-0012),
  finishing Milestone 3 except the explicitly-deferred per-copy edit/delete.
  Confirmed scope with the maintainer up front (search/filter/export only,
  not per-copy management) and confirmed the search-matching design
  (filter in application code against the same displayed artist/title the
  page renders, not raw SQL columns, since a scan confirmation's corrected
  values can differ from the shared `albums` row) and the search UX (debounced
  auto-submit via a small client toolbar, not a manual-submit form) before
  implementing either. `GET /library` gained `q`/`sort` query params behind a
  new `LibraryQuerySchema`; a new `GET /library/export` route returns the same
  filtered/sorted list as CSV. Wired up the collection/wishlist pages'
  previously non-functional search box and sort button. Verified in WSL/Node
  22.23.2: `npm run check` (61/61 unit tests), `npm run test:integration`
  (27/27), `npm run build` (26 web routes), `npm run test:e2e` (5/5,
  unchanged). Manually verified search/sort/export end-to-end against real
  seeded data in a running WSL dev server (a stale dev server process from an
  earlier session had to be killed and restarted first — its build predated
  this session's new contract exports and was throwing on every `/library`
  request); cleaned up the manually-seeded rows afterward, leaving
  pre-existing real/leftover-test data untouched. Uncommitted; the maintainer
  should review before commit (together with the still-uncommitted ADR-0011
  work from the prior session).

- **2026-08-31 - Claude.** Completed direct wishlist-to-owned/owned-to-wishlist
  conversion (ADR-0011), scoping down Milestone 3 task 3 after confirming with
  the maintainer to split it: this session did direct `PATCH`/`DELETE
/library/{itemId}` and left search/filter/export and per-copy edit/delete for
  next time. Found and finished an uncommitted, undocumented draft of
  `UpdateLibraryItemSchema` already sitting in the working tree (no prior
  session had logged it); simplified it from `{ list?, notes?, copy? }` to
  `{ list?, notes? }` after confirming with the maintainer that per-copy
  editing needs its own sub-resource design given the one-item-to-many-copies
  model. The first integration test run caught a real bug before commit: the
  initial `deleteLibraryItem` let a raw Postgres FK violation
  (`scan_confirmations_library_item_id_fkey`, `restrict` by design) escape
  instead of failing cleanly, which would have affected nearly every real
  library item since almost all of them have confirmation history. Fixed by
  checking for `scan_confirmations` rows first and rejecting with a clear
  `invalid_state` error; confirmed the resulting scope (confirmed items can't
  be hard-deleted yet) with the maintainer before proceeding. Also corrected
  pre-existing `docs/API.md` drift (a documented `POST /library` route that
  was never implemented). Verified in WSL/Node 22.23.2: `npm run check`
  (57/57 unit tests), `npm run test:integration` (26/26), `npm run build`
  (25 web routes), `npm run test:e2e` (5/5, unchanged). Manually exercised the
  new routes' error paths against a running WSL dev server; the Docker
  Postgres instance had no real library data to exercise the success path
  against (see "Current state"). Uncommitted; the maintainer should review
  before commit.

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

- **2026-09-08 - Codex.** Created the requested Phase 3-4 roadmap from the
  review and handoff: ten milestones with sequencing, acceptance evidence,
  cost/runtime gates, and deferrals. Included image reads, quotas, tracing,
  compatibility fixtures, generalized outbox, catalog ownership, audit/deletion
  invariants, and staged Terraform ownership transfer. Updated current state and
  resume point; preserved existing handoff history and package-lock edits.
  Validation: edited-document Prettier checks pass. `npm run check` stopped
  at existing formatting issues in 179 other files; lint/typecheck/tests were
  not reached. No application/infrastructure changes; build not required.

- **2026-09-08 - Codex.** Reworked batch scan review into compact album cards
  with cover thumbnails, artist/title/year, visible result state, and direct
  high-confidence save actions for collection or wishlist. Added the
  authenticated 60-second signed-thumbnail read endpoint (owner-scoped,
  `private, no-store`, original fallback for pre-thumbnail records), exposed a
  thumbnail image ID in the batch contract, and retained detailed review for
  corrections. `npm run check` passes (79 tests); the web build completed and
  produced `.next/BUILD_ID`.
- **2026-09-08 - Codex.** Removed the batch-card review dead end: both matched
  and needs-review candidates now provide direct collection/wishlist confirmation.
  Rejecting a proposed match offers a new scan or opens the same scan in
  manual-entry mode with blank identity fields. The detailed page remains an
  optional edit-details path. `npm run check` passes (79 tests).
- **2026-09-08 - Codex.** Compacted the `/scan` session queue into a three-column
  desktop album-preview grid (two columns on narrow phones). Each record card
  now uses a square cropped cover thumbnail and reduced metadata spacing rather
  than consuming the page width. `npm run check` passes (79 tests).
- **2026-09-08 - Codex.** Removed the batch-card "Edit details" action. Batch
  candidates now show available release metadata (year, label, catalog number)
  beneath artist/title; genre, tracklist, and runtime are not yet in the AI or
  catalog contract and are intentionally not guessed. Updated browser-test
  navigation to avoid relying on the removed UI link. `npm run check` passes
  (79 tests).

- **2026-09-09 - Claude.** Second ad hoc UX request the same day: review the
  app as a real user and improve it, especially the dashboard. Delivered real
  cover art across dashboard/scan-history/library (shared lazy `CoverArt`
  component over the existing signed-thumbnail endpoint, closing
  `UI_UX_REVIEW.md` rank 9), a new `/library/{itemId}` detail page with
  clickable cards replacing dead-end grids, a rebuilt copy editor with
  conditions and real save/delete feedback, first-ever notes editing, and
  ADR-0018 + migration 012 making saved records removable while their
  confirmation audit row survives. Verified with `npm run check` (79/79),
  `npm run build`, `npm run test:integration` (30/30 database), a 14-step
  scripted browser pass, axe WCAG 2 A/AA (no violations on five routes), and a
  Pixel 7 layout check. Browser regression coverage for the new detail page is
  still owed — see "Known gaps and risks."

- **2026-09-09 - Claude.** Ad hoc maintainer UX request, outside the P3.1
  sequence: dashboard "Latest scans" gained inline add-to-collection/wishlist
  and dismiss actions per scan (ADR-0017). Confirmed the "not as a batch"
  half of the request was already true (per-scan rows since ADR-0006) and
  implemented the add/dismiss half: `cancelScan` widened to accept
  `identified`/`needs_review`/`unresolved`/`failed` as dismissible pre-states
  (rejecting a scan that already has a confirmation), and
  `listScanSummariesForUser` gained a batched `confirmedList` lookup. New
  client component `apps/web/src/app/dashboard/scan-activity-row.tsx` wires
  both into the existing `/confirm`/`/cancel` routes via `router.refresh()`.
  Verified: `npm run check` (79/79), `npm run build`, `npm run test:integration`
  (28/28, +2 new tests), and a manual dev-server check with seeded/cleaned-up
  data confirming both actions and the server-side confirmed-scan guard.
  Discovered, but left unfixed as out of scope, a likely pre-existing
  `.strict()` schema bug in `GET /api/v1/scans` and a local Playwright e2e
  timeout unrelated to this change — both recorded under "Known gaps and
  risks" for whoever picks either up next.

- **2026-09-09 - Claude.** Resumed the roadmap sequence: implemented P3.1
  task 2 (bounded upload concurrency, persisted session queue, per-item
  progress, retry/cancel, review-later navigation, refresh rehydration with
  recapture) as a rewrite of `apps/web/src/app/scan/capture-session.tsx`; see
  "Current state" for the full design and the two idempotency-key/orphaned-
  scan bugs found and fixed while verifying the recapture-after-refresh path
  against a real dev server. No contract/schema/API change. Verified
  `npm run check` (79/79), `npm run build`, and a scripted Playwright pass
  against Postgres/Redis/MinIO with real images covering bounded concurrency,
  mid-upload reload/resume/recapture, and cancel-while-queued; all scratch
  verification files and the extra `next dev` instance used for it were
  removed afterward. Checked off task 2 in `docs/ROADMAP.md`.
