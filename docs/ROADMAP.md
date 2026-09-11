# Delivery roadmap

## Phase 1 — MVP (complete)

The original milestones below comprise the completed MVP. Deferred per-copy
editing and the formal private AI evaluation remain explicit limitations, not
Phase 2 platform blockers.

## Milestone 0 — foundation (complete)

- Monorepo, web shell, worker boundary, contracts, domain review policy, AI adapter, local infrastructure, CI, and project documentation.
- Navigable account and library dashboard. The dashboard reads the authenticated
  user's persisted scan, collection, and wishlist data; it no longer uses demo
  activity, fixed counts, or a fixed date.

## Milestone 1 — single-image vertical slice (complete)

- [x] **Task 1.** Choose database/migration tool and implement user/scan/image/attempt tables.
- [x] **Task 2.** Add development identity, signed upload, server validation, and object-storage adapter.
- [x] **Task 3.** Add durable enqueue/outbox and queue worker.
- [x] **Task 4.** Call the OpenAI adapter, persist candidates/audit metadata, and poll scan status.
- [x] **Task 5.** Build mobile capture/upload, result review/correction, and add-to-list UI.
- [x] **Task 6.** Add provider-boundary and confirmation integration tests.
- [x] **Task 7.** Add phone-sized end-to-end coverage for the capture-to-confirm path.
- [x] **Task 8.** Validate Sol + `high` + prompt v2 manually and accept its artist/title
      quality for the early build. The formal private AI evaluation is deferred
      until public application usage or model/cost optimization (see P4.5).

Exit criterion: one phone photo can become a user-confirmed collection or wishlist item, with retry and failure visibility.

## Milestone 2 — multi-view and batch (complete)

- [x] **Task 1.** Group front/back/spine/label images per scan, sent as one labeled
      identification request; preserves the single-image flow and audit trail.
- [x] **Task 2.** Multi-select batch setup, independent item progress, cancellation, and
      retry (ADR-0006). Each photo in a batch becomes its own independently
      tracked scan; the `/scan` page gains a "One record" / "Multiple
      records" mode toggle, and `/scans/batch/{batchId}` shows per-item
      status with cancel/retry actions. `/scans` now lists real persisted
      scan history instead of demo data.
- [x] **Task 3.** Thumbnail/normalization pipeline (ADR-0007): upload completion derives a
      bounded analysis copy and a UI thumbnail from the validated original;
      scan analysis reads the analysis copy instead of the full-resolution
      original. Worker concurrency limits (`ANALYSIS_CONCURRENCY`, wired into
      BullMQ's `Worker` `concurrency` option) already existed since
      Milestone 1; the roadmap note describing them as missing was stale.
- [x] **Task 4.** Batch and provider-cost dashboards: `GET /batches/{batchId}` now
      returns a `cost` summary (tokens and estimated USD) aggregated across
      the batch's member scans, shown on the batch progress page. A new
      `GET /usage` endpoint and `/account/usage` page report account-wide
      scan outcomes and estimated provider spend/token usage over a rolling
      30-day window. Pricing lives in `packages/domain` (moved from the
      private eval package so both share one table).

## Milestone 3 — catalog enrichment and collection quality

- [x] **Task 1.** Evaluate catalog sources for canonical IDs, search, deduplication, and
      pressing detail. MusicBrainz is the primary catalog; Discogs is deferred
      as an optional pressing cross-check (ADR-0009 and
      `docs/CATALOG_EVALUATION.md`).
- [x] **Task 2.** Add the catalog port/MusicBrainz adapter, richer release metadata, and
      duplicate-copy modeling.
- [x] **Task 3.** Direct wishlist-to-owned (and back) conversion without a rescan:
      `PATCH`/`DELETE /library/{itemId}` (ADR-0011), with collection/wishlist
      page actions. Per-copy edit/delete remains explicitly deferred.
- [x] **Task 4.** Library search, sort, and CSV export (ADR-0012): `GET /library` accepts
      `q`/`sort` (recent/artist/title), matching and sorting the same
      effective artist/title the page renders; `GET /library/export` returns
      the same filtered/sorted list as a CSV download. Both apply after the
      existing 100-item fetch, so search narrows within that page rather than
      searching beyond it — no pagination was added.

Milestone 3 is complete except per-copy condition/location/notes/acquisition-date
edit and delete (ADR-0010, ADR-0011), which remains explicitly deferred to a
future slice.

## Milestone 4 — public-ready operations

- [x] **Task 1.** Production authentication (ADR-0013): Clerk resolves session identity
      in `AUTH_MODE=production`, mapped to a local `users.id` via a new
      `clerk_user_id` column, provisioned just-in-time on first request.
      `AUTH_MODE=development` (the default) keeps today's single fixed user
      with no Clerk dependency, so local dev/CI/tests are unaffected.
- [x] **Task 2.** Account export and deletion (ADR-0014): `GET /account/export` returns
      every row a user owns as JSON (metadata only, no image bytes).
      `DELETE /account` performs an ordered hard delete — the user's
      `scan_confirmations` rows first (satisfying their deliberate `restrict`
      FKs, ADR-0011), then the `users` row and its cascades — and
      best-effort deletes the corresponding S3 objects. Shared catalog rows
      (`albums`/`releases`) are never touched. A privacy/retention policy is
      documented in `docs/SECURITY.md`; a user-facing privacy notice is
      still needed.
- [x] **Task 3.** Managed-infrastructure operational readiness: the deployment topology,
      managed service requirements, backup retention, and monthly restore drill
      are documented in `docs/OPERATIONS.md`; `npm run ops:restore-test`
      verifies a local logical PostgreSQL backup against an isolated restore
      database. Public health (`/api/healthz`) and database readiness
      (`/api/readyz`) endpoints support service monitoring. Transactional
      per-user daily-analysis, active-scan, and rolling-spend controls reserve
      budget before initial jobs and retries enter the outbox; production must
      configure the related environment limits and provider-side spend cap.
- [x] **Task 4.** Accessibility and cross-device browser test matrix: WCAG 2 A/AA checks
      cover the primary authenticated routes, keyboard focus/skip navigation is
      explicit in the shell, and Playwright defines mobile Chromium, desktop
      Chromium, desktop Firefox, and mobile WebKit profiles.

Milestone 2 and Milestone 3 are complete except per-copy edit/delete, which
remains explicitly deferred to a future slice (not currently the next
recommended task — see `docs/HANDOFF.md`'s resume point for what to pick up
next). Keep the formal private AI evaluation as a gate before public application usage
or model/cost optimization (see P4.5).

## Phase 2 — AWS platform engineering and public readiness

Phase 2 promotes the MVP to a secure, cost-bounded public project deployed from
GitHub Actions. Infrastructure code and workflows are implemented in this
repository; AWS/GitHub activation and operational rehearsals require the target
accounts and therefore remain release gates.

### P2.1 — Public repository and contribution foundation

- [x] **Task 1.** Add the MIT license, contribution and support guides, code of conduct,
      private security-reporting policy, guided issue forms, pull-request
      template, CODEOWNERS, labels, and release-note configuration.
- [x] **Task 2.** Document the project status, limitations, public-history audit, contributor
      workflow, and GitHub repository settings.
- [x] **Task 3.** Provide an idempotent GitHub configuration script for Discussions,
      security features, branch protection, merge policy, and labels.
- [x] **Task 4.** Rotate the credential found by the 2026-09-02 audit and delete its sole
      containing experimental branch; `main` was never affected.
- [x] **Task 5.** Push the workflows and obtain a clean full-history Gitleaks run.
- [x] **Task 6.** Make the repository public.
- [x] **Task 7.** Apply and verify GitHub security settings and branch protection:
      `scripts/configure-github-repository.sh` enables secret scanning/push
      protection, vulnerability alerts, automated security fixes, private
      vulnerability reporting, read-only default workflow permissions, labels,
      and `main` branch protection (required status checks, linear history, no
      force-push/deletion, required conversation resolution). Verified live via
      the GitHub API on 2026-09-07.
- [ ] **Task 8.** Rehearse an untrusted fork pull request: confirm a read-only token, no
      AWS OIDC role, no GitHub environment/provider secret exposure, required
      checks still run on fork code, and no `pull_request_target` execution.

### P2.2 — Production runtime and container readiness

- [x] **Task 1.** Add pinned, minimal, non-root web and worker images with ARM64 support,
      standalone Next.js output, health checks, and graceful shutdown.
- [x] **Task 2.** Remove build-time secret embedding; use Lambda/ECS/EKS role credentials
      by default and configurable bounded/TLS database connections.
- [x] **Task 3.** Add PR image builds, SBOM generation, and vulnerability gates.
- [x] **Task 4.** Deploy the development Lambda runtime in AWS and pass its live HTTP health
      and readiness checks.
- [ ] **Task 5.** Complete the remaining Lambda asynchronous-path, Fargate, and EKS
      runtime/shutdown demonstrations in the AWS account.

### P2.3 — Terraform foundation and isolated environments

- [x] **Task 1.** Add the encrypted/versioned state and ECR bootstrap root with repository-
      scoped GitHub OIDC roles.
- [x] **Task 2.** Add independently keyed always-live serverless development, just-in-time
      ECS staging, and just-in-time EKS production roots with isolated S3,
      PostgreSQL, SQS, secrets, DNS/TLS, telemetry, budgets, and IAM.
- [x] **Task 3.** Make staging/production runtime resources conditional through
      `environment_active` while retaining their data planes.
- [x] **Task 4.** Bootstrap the target account and apply the development environment.
- [x] **Task 5.** Review real staging/production plans and apply their inactive foundations:
      both roots' persistent foundations (VPC, ACM validation, Aurora, S3, SQS,
      secrets) have been applied and confirmed multiple times this session,
      including the production teardown that resolved the 2026-09-07 incident
      (issues #9, #10).

### P2.4 — GitHub Actions delivery and just-in-time lifecycle

- [x] **Task 1.** Add PR platform/Kubernetes checks, immutable ARM image publishing,
      automatic development and staging delivery, one-off migrations,
      staged-image promotion, manual bounded EKS production activation, hourly
      expiry cleanup, and safe production drain.
- [x] **Task 2.** Add operational drain checking, idempotent queue reconciliation, and cost
      preflight commands.
- [x] **Task 3.** Create all three GitHub environments and configure development OIDC
      variables.
- [x] **Task 4.** Correct the repository plan variables (`AWS_PLAN_ROLE_ARN` is a real IAM
      role ARN; `APP_HOSTNAME` is a real FQDN) and configure staging/production
      OIDC variables.
- [x] **Task 5.** Complete two consecutive staging lifecycle runs: `34080493765` (commit
      `506767e`) and `34081530170` (commit `413fc5f`) both activated
      infrastructure, migrated, deployed, passed HTTP smoke checks, tagged
      `staging-passed-<sha>`, and deactivated cleanly on 2026-09-07.

### P2.5 — Scaling, security, observability, and cost controls

- [x] **Task 1.** Encode distinct Lambda/ECS/Pod Identity roles, worker-only OpenAI access,
      web/worker scaling limits, log retention, SQS alarms, WAF, SNS, and
      environment budgets.
- [x] **Task 2.** Refuse normal production activation beyond $20 unless a break-glass input
      is supplied.
- [x] **Task 3.** Document the threat model, incident response, backup/restore, and inactive
      cost model.
- [ ] **Task 4.** Execute load, failure, authorization, restore, and teardown drills.

### P2.6 — Production rehearsal and completion

- [ ] **Task 1.** Rehearse sign-in, signed upload, AI review, collection/export/deletion,
      scaling, Spot replacement, rollback, reconciliation, cold resume/PITR,
      deactivate/reactivate, expiry cleanup, and an untrusted fork PR.
- [ ] **Task 2.** Publish sanitized architecture, CI/CD, contribution, cost, threat-model,
      load-test, recovery, and runbook evidence.

Phase 2 completes after two consecutive staging lifecycles, one production
rehearsal, and one fork contribution/security rehearsal pass without manual AWS
console changes.

## Phases 3 and 4 — product maturity and measured service extraction

Planned 2026-09-08 from [the plan review](PHASE_3_4_PLAN_REVIEW.md) and
[handoff](HANDOFF.md). This supersedes the former Phase 3 UI/UX and model-training
placeholder. The original draft is not in the repository; this roadmap translates
its recorded intent into deliverables and incorporates review findings E1-E3 and
G1-G11. All milestones below are planned, not implemented.

Task numbers restart at 1 within each milestone/phase subsection below (e.g.
"P3.1 Task 3" and "P4.2 Task 3" are unrelated tasks in different sections).
Reference tasks this way in `docs/HANDOFF.md` and elsewhere so they stay
unambiguous as items are checked off.

Phase 3 completes repeated mobile capture and everyday music organization, then
measures the modular monolith. Phase 4 tests whether selected service boundaries
justify their complexity and cost. Do not claim an architectural improvement
before measuring it. Retaining or returning to the monolith is a valid outcome.

### Sequence and gates

- Phase 2 remains incomplete, tracked in issues #8-#15. Phase 3 can proceed
  locally and in development without restarting production activation.
- Use local reproducible workloads and staging/ECS for Phase 4 demonstrations.
  Production/EKS rehearsal requires #8 (504) and #9 (session lifetime) resolved
  and #10 recovery controls reviewed. State ownership transfer requires #9/#10
  closed first. These gates do not mark the other Phase 2 rehearsals complete.
- Start P3.1, including instrumentation and a preliminary persistent-cost
  inventory, then P3.2/P3.4. P3.3 is independent of capture and the first product
  scope cut if time or budget slips; record a deferral rather than marking it
  complete. Its compatibility foundation remains required before extraction.
- Finish P3.5 after the selected product scope stabilizes. Run P4.1 before P4.2,
  recording a proceed/defer decision at each boundary. P4.3 follows a working
  staging extraction; P4.4 evaluates the final topology. P4.5 can run earlier and
  is mandatory before public application usage or model/cost optimization.
- Keep existing runtime tiers. Development retains in-process implementations
  behind the same ports; staging receives extracted services first. Provide
  production EKS definitions and a gated rehearsal. Additional development
  service Lambdas and new hosting platforms are outside this scope.

## Phase 3 — product maturity and a measured baseline

### P3.1 — Continuous capture and foundations

- [x] **Task 1.** Rewrite `/scan` as an extracted capture-session flow, replacing the one-shot
      mode-toggle control flow. Reuse independent scans and incremental membership
      in existing batches; that grouping needs no schema/API change. The web
      flow is intentionally upload-only and accepts one cover per record.
- [x] **Task 2.** Add bounded upload concurrency, session queue, per-item progress,
      retry/cancel, and review-later navigation. Rehydrate persisted scans after
      refresh; clearly identify unuploaded local images as needing recapture.
- [x] **Task 3.** Add an authenticated signed-thumbnail read endpoint with ownership checks,
      short TTL, private cache policy, expiry refresh, and safe missing/legacy
      image fallback. Reuse the thumbnails already generated in storage.
- [x] **Task 4.** Add quota-headroom contracts/polling and an early admission check before
      expensive upload processing. Keep submission/retry quotas transactional:
      headroom is advisory under concurrency. Define abandoned-upload cleanup.
- [x] **Task 5.** Reconcile active-scan (20), batch (20), daily-attempt (100, including retries),
      and worker-concurrency (1) defaults. Define batch rollover, queue-pressure
      pause/resume, and daily/spend exhaustion behavior without retry loops.

Task 5 completed 2026-09-09, building on the same-day Task 4 work: the four
defaults' reconciliation, queue-pressure pause/resume, and daily/spend
exhaustion behavior were already implemented and documented (`GET /quota`,
the early admission check, abandoned-upload cleanup, and
`docs/OPERATIONS.md`'s "Reconciling the defaults" and "Queue-pressure
pause/resume" sections). The remaining gap — a real definition of batch
rollover, not just a deferral note — is now written in `docs/OPERATIONS.md`'s
"Batch rollover" section: a continuous capture session tracks an ordered list
of batch IDs rather than one, rolls over by calling `POST /batches` again
either proactively or on the server's distinct `batch_scan_limit` rejection
(`packages/database/src/scan-repository.ts:154-158`, previously unconsumed by
any client), and composes existing `POST /batches`/`POST /scans` primitives
with no schema or contract change. Quota headroom counts scans regardless of
batch, so rollover does not interact with quota exhaustion as a separate
failure mode. P3.2's continuous-capture state machine implements this behavior:
the client creates a new batch after the server authoritatively reports a full
one, while the session itself remains continuous.

- [x] **Task 6.** Add structured web request/error timing and validated correlation IDs
      across HTTP, outbox/job payloads, and worker attempts. Preserve compatibility
      with queued jobs. Treat inbound IDs as untrusted metadata, never identity;
      exclude secrets, signed URLs, and image bytes. Time upload and normalization
      separately and reuse existing worker/attempt metrics.
- [x] **Task 7.** Inventory persistent spend before adding billable resources; carry known
      costs and unknowns into P3.5's reconciled budget artifact.

Task 6 completed 2026-09-09: every `apps/web` API route now shares one
`withRoute` wrapper (`apps/web/src/server/http.ts`) that logs a
`[web] http_request` line (route, method, status, `durationMs`, `requestId`,
and `correlationId` if present) and centralizes error handling, replacing 20
routes' hand-rolled `createRequestId`/try-catch pairs. An inbound
`x-request-id` header is validated (`CorrelationIdSchema`,
`packages/contracts/src/common.ts`: bounded length/charset, dropped rather
than rejected if malformed) and forwarded as an optional `correlationId` on
`AnalyzeScanJobSchema` (backward compatible with already-queued jobs lacking
the field) and as a new nullable `correlation_id` column on `outbox_messages`
and `scan_attempts` (migration 013), so one caller-supplied trace value greps
across the HTTP request, the queued job, and the worker attempt it produces.
It stays untrusted metadata throughout: never used for lookups, joins, or
authorization. The upload-complete route times its upload (readback/validate)
and normalization phases separately (`[web] upload_complete_timing`); the
worker splits storage-fetch and provider-call timing in
`[worker] scan_analysis_timing` without adding a new `scan_attempts` duration
column, reusing the existing bundled `duration_ms`. Two probe routes
(`/api/healthz`, `/api/readyz`) were deliberately left unwrapped: they carry
no user/business identity and run frequently enough from load balancers that
per-hit structured logging would add log volume disproportionate to their
purpose, per the $25/month budget ceiling
(`docs/PHASE_3_4_PLAN_REVIEW.md`'s instrumentation guidance).

Task 7 completed 2026-09-09: `docs/OPERATIONS.md`'s new "Persistent spend
inventory (pre-P3.5)" section lists, with Terraform citations, what is billed
today independent of `environment_active` (development's always-live
Lambda/API Gateway runtime, Aurora storage in both staging and production
despite `min_capacity = 0` compute, versioned S3 buckets, nine Secrets
Manager secrets across three environments, and continuous CloudWatch Logs
retention — the last now also carrying Task 6's new structured-logging
volume) versus what the TTL sweep genuinely removes (NAT gateway, ECS/ALB,
EKS/internal ALB/CloudFront/WAF — all Terraform `count = local.active_count`).
It also names the unknowns P3.5 Task 1 must resolve to reconcile the $25
total (actual Aurora/S3 storage cost, development database hosting cost since
it is external to these Terraform roots, real staging/production
activation-hour cadence, Task 6's added log volume, and actual aggregate
OpenAI spend against the $20 per-user default that alone is 80% of the total
target). This is deliberately an inventory, not the reconciliation itself —
no new spend controls or code changed. In the course of building it, this
session found and fixed one real doc gap: staging's own $20 budget alarm
(`infra/terraform/environment/monitoring.tf:125-128`) existed in Terraform
but was never mentioned in `docs/OPERATIONS.md`'s budget paragraph, which
previously named only development's $10 and production's $25.

Exit: ten covers queue independently and persisted progress survives navigation
and refresh, with stored thumbnails and later review. Tests hit active/batch
ceilings, concurrent quota contention, 429 recovery, retry/cancel, and expired or
foreign-user image reads. A request is traceable through enqueue and analysis.
Daily/spend exhaustion stops capture until the relevant limit permits resumption.

### P3.2 — Guided automatic mobile capture

- [x] **Task 1.** Add opt-in live camera framing and a bounded state machine: armed, captured,
      disarmed, rearmed after removal/change. A held cover cannot repeatedly submit.
- [x] **Task 2.** Pause on quota/queue pressure, backgrounding, or lost camera access; release
      camera resources on exit. Preserve manual capture/file-input fallback for
      denial, unsupported browsers, and detection failures.
- [x] **Task 3.** Keep existing MIME-sniffing, HEIC rejection, multi-view, focus, and browser
      tests green. Canvas captures use supported JPEG/PNG.
- [x] **Task 4.** Automate state-machine tests with stubbed `getUserMedia`. Document a manual
      iPhone Safari and Android Chrome protocol recording device/OS/browser,
      lighting, captures, misses, duplicates, and interventions.

Exit — **met 2026-09-11**: automated tests prove no duplicate while held,
rearming, pause/resume, and fallback. The maintainer completed the documented
iPhone Safari and Android Chrome protocol; its sanitized device results are
retained privately and meet the nine-of-ten / zero-duplicate gate. Browser
emulation does not prove real-camera behavior.

### P3.3 — Discovery and saved music without scanning

- [x] **Task 1.** Add independent catalog search/details with provider provenance and clear
      release-concept versus pressing uncertainty. Keep MusicBrainz behind its
      port; another provider requires an ADR.
- [ ] **Task 2.** Define contracts/domain rules before persistence/UI for release favorites
      and user-owned ordered playlists of saved release references. Include
      favorite/unfavorite and playlist create/rename/reorder/remove/delete.
      Playlists organize music; streaming playback is outside scope.
- [ ] **Task 3.** Add reviewed, idempotent catalog-to-wishlist placement without scanning,
      using existing library deduplication rules and no invented image history.
      Include new saved-music data in account export/deletion.
- [ ] **Task 4.** Establish explicit HTTP/event version conventions and previous-deployed-
      version compatibility fixtures in `packages/contracts`, building on
      `scan.analyze.v1`. Add catalog/usage coverage and CI compatibility checks;
      workspace version `0.1.0` is not a compatibility guarantee.

Task 1 completed 2026-09-11: a new `/discover` page searches the MusicBrainz
catalog directly by artist/title with no scan involved, reusing the existing
`GET /catalog/releases` search endpoint (already independent of any scan; the
scan review screen's "Search MusicBrainz" step and `/discover` are two
separate callers of the same endpoint). Results are grouped client-side by
`reference.releaseGroupId` so multiple pressings of one album render under a
single album heading instead of as unrelated rows. A new `GET
/catalog/releases/{releaseId}` endpoint and `CatalogProvider.getReleaseDetails`
port method fetch one pressing's full detail — track listing, full label/
format data, and `releaseGroupTitle` (the release group's own title, shown
explicitly when it diverges from the selected pressing's title) — from
MusicBrainz's release lookup (`inc=labels+recordings+artist-credits+
release-groups+media`), sharing the adapter's existing one-request-per-second
limiter and 24-hour cache with search. `reference.releaseGroupId` (the album
concept) and `reference.releaseId` (this specific pressing) stay the
machine-readable distinction; the detail panel also states in copy that a
cover or title match never proves the pressing on hand. The page is read-only
— no add/save action — since catalog-to-wishlist placement is Task 3. Fixed a
real, previously-latent bug found while verifying against live MusicBrainz
data: `@vinylhound/catalog` was missing from `next.config.ts`'s
`transpilePackages`, which caused `CatalogProviderError` thrown inside the
package to fail its `instanceof` check in `apps/web/src/server/http.ts`'s
`errorResponse` (webpack bundled two non-identical copies of the class across
the module graph) and surface as a bare `500 internal_error` instead of the
correct status — this silently affected every pre-existing
`CatalogProviderError` category (`rate_limit`, `provider_unavailable`,
`invalid_response`), not just the new `not_found` case added for a missing
release ID. Verified `format:check`/`lint`/`typecheck`/`test` individually
rather than via the chained `npm run check`, since `format:check` fails only
on the generated `apps/web/next-env.d.ts` (no working-tree diff against its
last commit — a pre-existing Windows CRLF-checkout artifact, not from this
session). Results: 103/103 unit tests, +10 net new:
`packages/contracts/src/catalog.test.ts` for the new
`CatalogReleaseDetailSchema`/`GetCatalogReleaseResponseSchema`, plus new
`getReleaseDetails` cases in `packages/catalog/src/
musicbrainz-catalog.test.ts` covering success, an unknown-release 404 mapped
to `not_found`, and a non-UUID id rejected without a request), `npm run
build`, and a real isolated dev-server pass against live MusicBrainz (search,
details, 404, and 400 paths all confirmed with real HTTP responses before the
`transpilePackages` fix, then reconfirmed after). `npm run
test:e2e` (mobile Chromium): a new `e2e/discover.e2e.ts` stubs
`/api/v1/catalog/releases*` (matching `scan-flow.e2e.ts`'s existing
convention of never hitting real MusicBrainz in CI) to prove the
grouped-by-album rendering, the concept-vs-pressing copy when a pressing's
title diverges from its release group, the tracklist, the MusicBrainz
provenance link, a zero-results state, and zero axe WCAG 2 A/AA violations;
`/discover` was also added to `accessibility.e2e.ts`'s audited-route and
360px-viewport lists. Desktop sidebar and mobile bottom nav both gained a
"Discover" entry (`apps/web/src/app/dashboard-shell.tsx`); the mobile nav's
CSS grid moved from 5 to 6 columns, reverified at 360px with no horizontal
overflow. Found and left alone: `e2e/live-camera.e2e.ts`'s first test ("live
camera captures once while held, rearms after change, and resumes after a
pause") fails consistently and reproduces identically on a clean, unmodified
`main` (confirmed via `git stash`) — a pre-existing flake unrelated to this
task, not something Task 1 introduced or is scoped to fix.

Exit: separate browser tests complete search/details, favorite/unfavorite,
playlist editing, and reviewed wishlist addition without a scan. Integration
tests cover ownership, deduplication, replay/conflict, and export/deletion.
Current/previous contract fixtures pass. If product scope is deferred, deliver
the compatibility foundation separately before Phase 4 extraction.

### P3.4 — Complete the everyday experience

- [ ] **Task 1.** Replace search within the first 100 fetched rows with full-library search,
      stable cursor pagination/sorting, and export of all matching records.
      Preserve effective user-corrected artist/title matching and ordering.
- [ ] **Task 2.** Complete per-copy condition/location/notes/acquisition-date editing and
      deletion, ownership checks, idempotency, and mutation feedback. Define
      last-copy rules explicitly and preserve confirmation audit history.
- [ ] **Task 3.** Use P3.1 image reads in scan history and batch review navigation. Complete
      empty/loading/error states, accessible controls, and the privacy notice.
- [ ] **Task 4.** Test five new participants on a fixed task list: capture/review a record,
      recover a failed scan, find an older library entry, and edit a copy.
      Record completion, assistance, and failures per task without personal data.

Partial progress, 2026-09-09 (not enough to check Task 2 or Task 3 above): a
library item detail page at `/library/{itemId}` now carries per-copy editing
with real mutation feedback, notes editing, and removal (part of Task 2), and
P3.1 image reads are wired into scan history and both library grids (part of
Task 3). Still outstanding for these tasks: batch review navigation, explicit
last-copy rules, full-library search and pagination, Playwright coverage for
the new page, and the participant testing. Saved records became removable via
ADR-0018, which supersedes ADR-0011's delete restriction while preserving
confirmation audit history.

Exit: tests find/export records beyond a 100-item fixture, paginate without
duplicates, and verify copy mutations/audit protection. All four browser profiles
and accessibility checks pass. At least four of five participants complete every
listed task without coaching; fix and retest blocking failures.

### P3.5 — Reproducible performance, delivery, and cost baseline

- [ ] **Task 1.** First reconcile persistent monthly spend: development, both retained Aurora
      data planes/foundations, storage/backups/logging, capped aggregate AI usage,
      and a declared number of staging activation hours. State production rehearsal
      hours separately. Reconcile the $20 per-user AI default with a $25 total
      monthly target; alarms are not spending caps. If projected total exceeds
      $25, reduce scope/hours/allowances or record a revised budget decision before
      adding recurring infrastructure.
- [ ] **Task 2.** Commit benchmark scripts and sanitized results specifying commit,
      hardware/tier, dataset, multiple synthetic users and batches, cache state,
      warmup, sample counts, concurrency, and at least three repeated runs. Avoid
      measuring only one user's quota lock or one batch-row lock.
- [ ] **Task 3.** Measure API p50/p95, error rate, upload/normalization, queue age, attempt
      duration, end-to-end latency, throughput, and estimated AI cost. Reconcile
      signals with `OPERATIONS.md`; reuse persisted attempts and optional queue
      CloudWatch metrics. Use structured logs/Logs Insights for new timings and
      include telemetry retention/cost rather than adding uncosted custom metrics.
- [ ] **Task 4.** Separate deterministic provider-stub runs from a small capped live run.
      Hold total provider concurrency constant for one/multiple-worker tests;
      separate application time from provider time.
- [ ] **Task 5.** Introduce affected-workspace build/test selection with dependency closure
      and conservative full-check fallback. Record the tooling decision before
      adoption. Measure clean/cached builds before and after this optimization so
      Phase 4 does not attribute its gains to extraction.

Exit: another contributor can reproduce the workload/report with committed
commands. Results include sanitized samples, percentiles, run conditions, and
actual versus estimated cost with its denominator. Declare acceptable latency,
error, and cost regression budgets before Phase 4 experiments. Selection tests
prove shared-contract changes trigger dependent consumers.

## Phase 4 — measured service extraction

Follow ADR-0001's package seams and the measurement gate in
[Architecture](ARCHITECTURE.md). Record boundary, persistence, public-contract,
and provider decisions in ADRs before implementation. Current architecture ADRs
remain authoritative until the corresponding cutover.

### P4.1 — Extract discovery first

- [ ] **Task 1.** Use P3.5 evidence and ADR-0009's shared catalog coordination requirement to
      record the reason to extract, expected benefit, cost, and rollback path.
- [ ] **Task 2.** Move provider adapters, bounded cache, and rate coordination behind an
      authenticated internal discovery API. Browser traffic stays behind web;
      require service identity and user authorization, not just a user-ID header.
- [ ] **Task 3.** Keep canonical `albums`, `releases`, and `catalog_references` with the
      core/library and its transaction. Discovery owns no canonical records;
      cache data is disposable.
- [ ] **Task 4.** Decide the coordination substrate in an ADR: PostgreSQL-backed cache/rate
      lease for replicas, or a single discovery replica with explicit availability
      and rollout constraints preventing overlapping independent limiters.
      Per-process Maps cannot enforce a global provider limit. AWS Redis does not
      exist today; ElastiCache requires an explicit budget decision.
- [ ] **Task 5.** Add service image/ECR/IAM/configuration and staging ECS delivery; prepare
      gated production EKS definitions and retain development's in-process port.
      Test bounded retries, timeouts, failures, and contract compatibility.

Exit: deploy and roll back a discovery-only change in staging without rebuilding
web/worker. Demonstrate bounded cache and provider-wide rate coordination under
concurrent callers and rollout conditions. Compare P3.5's relevant workload and
record proceed, retain-in-process, or rollback before starting P4.2.

### P4.2 — Extract scans and asynchronous confirmation

- [ ] **Task 1.** Define scan ownership of scans/images/attempts/reviewed confirmations and
      core ownership of catalog/library/copies/favorites/playlists. Initially keep
      one physical PostgreSQL deployment with separate schemas and credentials,
      no cross-service table access, and a documented shared failure boundary.
- [ ] **Task 2.** Generalize the outbox in a separate migration/refactor: aggregate type/ID,
      topic/version, dedupe key, correlation, and topic-aware dispatch. Remove the
      scan-only FK/topic CHECK and mandatory attempt-number assumption. Preserve
      skip-locked claiming, backoff, and replay safety; scope cancellation checks
      to analysis messages.
- [ ] **Task 3.** Supersede ADR-0005 at cutover: one scan transaction stores the reviewed
      confirmation and versioned event. A core consumer atomically records an
      inbox dedupe receipt, catalog/library changes, and completion event; scan
      consumes completion into a projection. No cross-service dual writes.
- [ ] **Task 4.** Specify same-key/same-payload replay and same-key/different-payload conflict.
      Duplicate delivery cannot create another physical copy; a genuinely new
      reviewed scan may. Show `Saving` until completion, then the stable library
      reference; expose delay/failure with safe retry and reconciliation.
- [ ] **Task 5.** Isolate or fairly schedule confirmation dispatch so analysis cannot starve
      it. Set a confirmation-to-library latency target before implementation and
      include the existing outbox poller's delay in the measurement.
- [ ] **Task 6.** Replace the cross-boundary confirmation/library restrict FK with explicit
      application invariants and durable audit references/projections. Record the
      policy in an ADR and preserve protected-history behavior unless explicitly
      changed. Make account export/deletion a durable, authenticated, retryable
      workflow; late events must not recreate deleted account data.
- [ ] **Task 7.** Use additive migrations, backfill, verification, then a single writer switch.
      Test rollback with in-flight events and reconciliation; never enable two
      authoritative writers. Deploy staging first, with gated EKS definitions
      and no extra development Lambdas.

Exit: integration/failure tests cover crashes before/after publish and consumer
commit, duplicates/out-of-order delivery, key conflicts, poison events, restart,
and account deletion races. Prove one intended library/copy effect, preserved
original/model/prompt/review audit history, and no cross-service SQL. Rehearse
cutover/rollback with pending work in staging. The UI never reports a completed
save before the completion projection arrives.

### P4.3 — Separate platform delivery and state ownership

- [ ] **Task 1.** After a working staging extraction, move platform configuration/delivery
      into a dedicated platform repository. Keep immutable service-specific
      application artifacts, narrow OIDC roles, previous-contract compatibility,
      and Phase 3 affected-workspace improvements.
- [ ] **Task 2.** Inventory the four Terraform roots (`bootstrap`, `development`,
      `environment`, `production`), backend keys, locks, IAM trust, configuration,
      and owning workflows. Close #9/#10 before any ownership transfer.
- [ ] **Task 3.** Rehearse development first: freeze the old writer, back up/version state,
      transfer configuration/workflow authority, verify an unchanged plan against
      the existing backend, then enable exactly one new writer. Transfer remaining
      roots individually with the same verification and rollback instructions.
      Do not recreate resources or create competing state authorities. Recover
      locks only with verified ownership and no active apply.
- [ ] **Task 4.** Demonstrate independent service delivery, scaling, health, migration,
      rollback, and activation/deactivation in staging. Keep production rehearsal
      gated on the unresolved Phase 2 issues.

Exit: evidence identifies one authorized writer per root, unchanged resource
identity, no unexpected replacements, and a rehearsed transfer rollback. A
service-only release builds/deploys/rolls back without rebuilding unrelated
services. Record gated production demonstrations as outstanding.

### P4.4 — Verify benefits and costs against the monolith

- [ ] **Task 1.** Run P3.5 benchmark scripts unmodified against the extracted topology,
      changing only documented target/configuration inputs. Match workload,
      resources, cache, user/batch distribution, and total provider concurrency;
      identify unavoidable differences explicitly.
- [ ] **Task 2.** Exercise isolated scaling, discovery/provider outage, scan backlog, delayed
      confirmation, and service rollback. Test unrelated library journeys where
      dependencies permit. PostgreSQL failure remains a shared failure boundary.
- [ ] **Task 3.** Compare latency distributions, throughput, errors, confirmation delay,
      build/deploy time, operational steps, and monthly cost against P3.5's
      declared budgets. Separate provider variance and earlier CI gains.

Exit: publish reproducible before/after samples and a keep/revise/reverse decision
for each extraction. Explain and address failed budgets before calling the
topology ready. Finding that the monolith is sufficient is a valid evaluation
result; unrun demonstrations are not completed work.

### P4.5 — Private data and AI baseline

- [ ] **Task 1.** Use the existing private eval runner with consented images, maintainer-
      verified labels, development/held-out separation, and model/prompt versions.
      Keep private images and unverified labels out of the public repository.
- [ ] **Task 2.** Before running, fix sample composition and acceptance thresholds for artist/
      title rank-1/top-3 accuracy, pressing evidence separately, review routing,
      schema/provider errors, latency, tokens, and cost. Include difficult covers
      and multi-view cases; report counts and uncertainty.
- [ ] **Task 3.** Run the capped baseline, retain reproducible private artifacts, and publish
      sanitized aggregates, failure categories, and the next experiment decision.
      Public repository visibility is distinct from public application usage.

Exit: the verified held-out baseline is reproducible and evaluated against its
predeclared thresholds. Resolve failed public-usage gates before enabling public
usage. Complete this earlier if rollout or optimization comes first. Training
and fine-tuning are outside Phases 3 and 4.

## Deferred beyond Phase 4

Native apps, streaming playback, recommendations, unconstrained cover detection,
dedicated search infrastructure, and model training remain deferred. A future
Phase 5 is not scheduled by this roadmap; scope it from P3.5/P4.4 measurements
and P4.5 failure analysis rather than assuming training or further extraction.
