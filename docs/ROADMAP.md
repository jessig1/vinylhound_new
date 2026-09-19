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
- [x] **Task 2.** Define contracts/domain rules before persistence/UI for release favorites
      and user-owned ordered playlists of saved release references. Include
      favorite/unfavorite and playlist create/rename/reorder/remove/delete.
      Playlists organize music; streaming playback is outside scope.
- [x] **Task 3.** Add reviewed, idempotent catalog-to-wishlist placement without scanning,
      using existing library deduplication rules and no invented image history.
      Include new saved-music data in account export/deletion.
- [x] **Task 4.** Establish explicit HTTP/event version conventions and previous-deployed-
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

Task 1 revised and Task 3 completed 2026-09-11 (ADR-0019). `/discover` was
rebuilt on **Spotify** as a separate discovery provider, keeping MusicBrainz as
the catalog provider for scan review and pressing identity. The two-field
artist+title form is replaced by one debounced free-text box returning Artists,
Albums and Tracks as three sections with artwork, and a browse chain of search
→ artist discography → album tracklist (`/discover`,
`/discover/artists/{id}`, `/discover/albums/{id}`). The query lives in the URL
as `?q=`, so a search is shareable and survives the back button, and each
keystroke aborts the previous in-flight request rather than racing it.

Why two providers rather than a swap: Spotify has no pressing entity at all —
no catalog number, country, format, packaging or release status — so replacing
MusicBrainz would have emptied exactly the fields scan review collects and that
distinguish one vinyl pressing from another. Spotify is much better at the
browse experience (relevance, inline artwork, artist-first navigation, no
1 req/s ceiling); MusicBrainz is the one that models physical editions. The
split is enforced structurally: separate ports (`CatalogProvider` versus
`DiscoveryProvider`), separate contracts (`catalog.ts` versus `discovery.ts`),
separate routes (`/catalog/*` versus `/discovery/*`).

`CatalogReferenceSchema` gained a nullable `releaseId`, rejected as non-null
for Spotify and still required for MusicBrainz. Null is not missing data: it is
the machine-readable statement that the provider models no pressing.
`resolveReviewedRelease` (extracted from `confirmScan`, now shared by both
save paths) derives release identity from a provider reference only when that
reference names a pressing, so a Spotify-sourced record dedupes on normalized
attributes exactly as a hand-entered one does and two real pressings stay two
releases. Fields Spotify cannot answer are saved as null, never guessed; only
`label` and the UPC/EAN `barcode` carry over.

Task 3's placement is `POST /library` (`PlaceLibraryReleaseSchema`), idempotent
by identity rather than by key — upsert on `(user_id, release_id)`, `collection`
outranking `wishlist`, and an owned copy created only when the item has none
yet. It writes no `scan_confirmations` row and leaves `confirmedFromScanId`
null, since no scan was reviewed and there is no image history to attribute.
Account export and deletion needed no change and were verified to cover the new
records: placement writes only to the existing user-scoped `library_items` and
`library_copies`, which export already selects by `userId` and which cascade
from the `users` delete.

Discovery is optional per deployment. With `SPOTIFY_CLIENT_ID`/
`SPOTIFY_CLIENT_SECRET` unset, `context.discovery` is null, the routes answer
`503 discovery_not_configured`, and `/discover` says so; scanning, review,
confirmation and the library are unaffected. Credentials are server-side only.

Verified: `npm run lint`, `npm run typecheck`, `npm test` (120/120, +17 net new
across `packages/catalog/src/spotify-discovery.test.ts` covering token reuse,
single refresh on a rejected token, unified search mapping, null/placeholder
filtering, per-market discography collapse, album label/barcode/tracks, local
rejection of malformed IDs, and the rate-limit/not-configured/not-found error
mappings; plus `packages/contracts/src/catalog.test.ts` cases proving a
MusicBrainz reference must carry a pressing, a Spotify one must not, and rows
persisted before Spotify existed still parse), `npm run build`, and `npm run
test:e2e` (mobile Chromium, 22/23). The rewritten `e2e/discover.e2e.ts` stubs
`/api/v1/discovery/*` and proves the three-section search, URL query state, the
search → artist → album walk, saving to the library with the assertion that no
pressing field is invented and the reference claims no pressing, the
unconfigured-deployment message, and the empty-result state, with zero axe
WCAG 2 A/AA violations on both the search and album pages. `format:check`
still fails only on the generated `apps/web/next-env.d.ts` (no working-tree
diff against its last commit — the same pre-existing Windows CRLF artifact
noted for Task 1). The one e2e failure is `e2e/live-camera.e2e.ts`'s first
test, still the pre-existing flake that reproduces on clean `main` and is
unrelated to this work.

Task 2 completed 2026-09-12 (ADR-0021). Contracts and domain rules came
first, then persistence, routes, UI and tests. **A favorite is an attribute
of the saved record** — a nullable `library_items.favorited_at`, not a third
list or a separate table — so a record in either list can be one, nothing
unsaved can be, removing the record removes the favorite, and export/deletion
cover it with no new plumbing. `PATCH /library/{itemId}` gained
`{ favorite }` (idempotent by identity: re-favoriting keeps the original
timestamp, `resolveFavoritedAt` in `@vinylhound/domain`), `GET
/library/favorites` reads favorites across both lists, and `/favorites` is
the library page filtered. **A playlist is a user-owned ordered list of the
user's own library items**: `playlists` (name unique per user after
`normalizePlaylistName`) and `playlist_entries` (`library_item_id`,
`position`), migration 016. The add contract admits only `{ libraryItemId }`,
so a playlist can hold only saved music by construction — the guard against
"playlist" quietly becoming a streaming queue now that discovery is Spotify.
Rules in `@vinylhound/domain` with unit tests: one entry per saved release
per playlist; append after the current maximum position; positions unique
and ascending but not contiguous (a cascade delete leaves a gap, a reorder
renumbers); a reorder must name every current entry exactly once
(`resolvePlaylistOrder`) and a stale or partial order is `409`, never
partially applied; 100 playlists per user, 500 entries per playlist. Create
and add are idempotent by identity like `POST /library` (no
`Idempotency-Key`; `201` created / `200` converged); every mutation locks
the playlist row, and creates take a per-user advisory lock so the count
check cannot be raced. Ownership is by absence: another user's playlist,
entry, or record is `404` everywhere. Routes: `GET/POST /playlists`,
`GET/PATCH/DELETE /playlists/{id}`, `POST /playlists/{id}/entries`, `DELETE
/playlists/{id}/entries/{entryId}`. UI: `/playlists` (create, list),
`/playlists/{id}` (rename, move up/down, remove, delete with confirm; a `409`
on reorder reloads the playlist), "Add to favorites" and an "Add to
playlist" section with current memberships on `/library/{itemId}`, a star
badge on cards, and a "Saved music" strip (Collection · Wishlist · Favorites
· Playlists) on all four pages so phones reach the new views without adding
bottom-nav columns; desktop sidebar gained both. Account export gained
`favoritedAt`, `playlists`, and `playlistEntries`; deletion cascades. Verified:
`lint`, `typecheck`, `test` (144/144, +22: `packages/domain/src/favorites.test.ts`,
`playlists.test.ts`, `packages/contracts/src/playlist.test.ts`, plus
favorites cases in `library.test.ts` and `account.test.ts`), `npm run
test:integration --workspace @vinylhound/database` (40/40, +6 in a new
"favorites and playlists" block covering idempotent favorite/unfavorite and
the cross-list favorites read, create-by-name replay and rename conflict,
append order and dedupe, ownership across every operation, permutation
reorder plus stale/partial rejection, gap-preserving removal and cascade from
library-item delete, both limits, and export/deletion of the new rows — the
placement path from Task 3 got its first integration coverage as a side
effect, since the block seeds records through `placeLibraryRelease`), `npm
run build`, and `npm run test:e2e` (new `e2e/saved-music.e2e.ts`: favorite →
appears on `/favorites` with zero axe violations → unfavorite → gone; create
playlist → add two records from their pages → reorder and reload to prove
persistence → remove → rename → axe → index shows the count → delete →
records survive; `/favorites` and `/playlists` added to the audited-route
and 360px lists).

Task 4 completed 2026-09-12 (ADR-0022). Versions are explicit and travel on
the wire: `API_VERSION`/`API_BASE_PATH` name the `/api/v1` surface, and event
topics are `<aggregate>.<action>.v<N>` with the same `N` as a literal in the
payload — `defineEventContract` refuses a topic and payload that disagree,
and `EVENT_CONTRACTS` registers every topic (today: `scan.analyze.v1`).
Workspace `0.1.0` is stated, in code and docs, to be no compatibility
identifier. **Producers are strict, consumers are tolerant:** each event
contract exposes `producerSchema` (strict) and `consumerSchema` (unknown keys
stripped), and the six places that read a stored or delivered job payload —
replay lookups, the outbox dispatcher, the republish scan, the SQS parser, the
BullMQ worker — now use the consumer schema, closing a real gap: every one of
them parsed strictly, so the `correlationId` addition on 2026-09-09 would have
failed every new job on a worker still running the previous version. The rule
that follows: a field may be added within a version only if optional and
advisory; anything a consumer must not lose is a new topic version.
`packages/contracts/fixtures/` holds 35 frozen wire samples reconstructed
from git history (the single-scan request before batches, the upload request
before view types, the confirm body before pressing fields, the job payload
before correlation IDs, the library update before favorites, a Spotify
placement with `releaseId: null`, plus a current sample of every response the
browser parses strictly, every mutating request body, both catalog reads and
the usage summary), each citing the commit that introduced its shape. Two
checks: `compatibility.test.ts` under `npm test` proves this tree accepts
every fixture, responses round-trip unchanged, and every registered topic
and browser-parsed response has a sample; `npm run check:contracts` (its own
CI step, base = PR base or the pushed-over commit) extracts the previous
commit's `packages/contracts/src` from git and proves its consumers accept
this tree's event payloads, fails on any fixture edited in place, and reports
HTTP shapes the previous version would reject — run against the first
vertical slice it names exactly the six additions that were stale-tab breaks
when they shipped. `catalog.ts`, `usage.ts` and `discovery.ts` gained
contract tests (+24); with the versioning helpers (+19) and the fixture
suite (+96) the package goes from 66 to 205 tests and the repository from
144 to 283. Verified: `lint`, `typecheck`,
`test`, `check:contracts` against `origin/main` and against `8c692ed`, the
in-place-edit and event-rejection failure paths in a throwaway worktree, and
`build`. Same day, follow-up: the one gap the first pass left open — the
browser parsed seventeen responses strictly, so an added response field
broke a tab opened before the deploy until it reloaded — is closed.
`tolerant(schema)` in `@vinylhound/contracts` clones a schema into strip
mode at every depth (objects, arrays, wrappers, unions, records, tuples,
pipes, lazies), keeping every refinement; `consumerSchema` is now
`tolerant(producerSchema)` rather than a top-level `.strip()`, and the 23
browser parse sites across seven client files read through
`parseResponse(schema, json)`. The server still validates what it emits
strictly. The forward check judges response fixtures with the base version's
own `tolerant()` when it exports one, so a response rejection now means a
removed, renamed or retyped field only — proved in a throwaway worktree
where an added response field was accepted by the previous version and a
removed one reported. `tolerant.test.ts` (+7) covers a real four-level
response, refinements, memoization and every node kind; `npm run test:e2e`
is 26/27 (the pre-existing `live-camera` flake), with every browser flow
now reading through the tolerant reader.

P3.3 is complete.

Exit: separate browser tests complete search/details, favorite/unfavorite,
playlist editing, and reviewed wishlist addition without a scan. Integration
tests cover ownership, deduplication, replay/conflict, and export/deletion.
Current/previous contract fixtures pass. If product scope is deferred, deliver
the compatibility foundation separately before Phase 4 extraction.

### P3.4 — Complete the everyday experience

- [x] **Task 1.** Replace search within the first 100 fetched rows with full-library search,
      stable cursor pagination/sorting, and export of all matching records.
      Preserve effective user-corrected artist/title matching and ordering.
      (ADR-0023, 2026-09-12)
- [x] **Task 2.** Complete per-copy condition/location/notes/acquisition-date editing and
      deletion, ownership checks, idempotency, and mutation feedback. Define
      last-copy rules explicitly and preserve confirmation audit history.
      (ADR-0024, 2026-09-12)
- [x] **Task 3.** Use P3.1 image reads in scan history and batch review navigation. Complete
      empty/loading/error states, accessible controls, and the privacy notice.
      (2026-09-17)
- [ ] **Task 4.** Test five new participants on a fixed task list: capture/review a record,
      recover a failed scan, find an older library entry, and edit a copy.
      Record completion, assistance, and failures per task without personal data.

Partial progress, 2026-09-09 (not enough to check Task 3 above): a library
item detail page at `/library/{itemId}` now carries per-copy editing with
real mutation feedback, notes editing, and removal, and P3.1 image reads are
wired into scan history and both library grids (part of Task 3). Still
outstanding for Task 3: batch review navigation; and the participant
testing for Task 4. Saved records became removable via ADR-0018, which
supersedes ADR-0011's delete restriction while preserving confirmation audit
history. Task 1 (2026-09-12) closed full-library search and pagination.
Task 2 (2026-09-12, ADR-0024) closed the copy commands: the last-copy rule
(removing the last copy keeps the record in the collection with none
recorded until the user moves or removes it), `POST /library/{itemId}/copies`
under an `Idempotency-Key`, integration tests for ownership, idempotency and
audit survival, and Playwright coverage of the detail page.

Task 3 completed 2026-09-17: the batch review page (`/scans/batch/{batchId}`)
was the one screen still reading thumbnails through its own fetch-and-`<img>`
`BatchThumbnail`, duplicating what P3.1's signed-thumbnail endpoint already
gives every other screen through the shared `CoverArt` component (scan
history and both library grids already used it, per the 2026-09-09 note
above). It now renders through `CoverArt` like the rest of the app, with a
per-card `toneFor` hash for the placeholder tone matching the convention
already duplicated across `scans/page.tsx`, `dashboard/page.tsx`,
`dashboard/scan-activity-row.tsx`, `discover/discovery-client.ts`, and
`library-album-card.tsx`. Each card's title is now an `h2` (was a bare
`<strong>`) so the batch grid exposes a heading per record, matching
`library-album-card.tsx` and `scans/page.tsx`'s own row markup. The
"This isn't a match" disclosure now sets `aria-expanded`/`aria-controls` and
keeps its target `<div>` mounted with the `hidden` attribute rather than
conditionally rendering it, so the `aria-controls` reference always resolves
to a real element (a `[hidden]` CSS override was needed since the class
already declared `display: grid`, which otherwise beats the attribute's
default `display: none` at equal specificity). A `batch.scans.length === 0`
branch (a batch whose only scans were canceled or never uploaded) now renders
the same `library-empty` empty state pattern used elsewhere instead of
silently rendering a zero-item grid; the existing loading/error states
(`aria-live="polite"` spinner; a message card with a "Back to scan history"
link, while polling keeps retrying underneath) were reviewed and left as
they already matched the pattern used by `/scans/{scanId}`.

Found and fixed a real, unrelated bug while adding `/privacy` to the WCAG
audit list: `apps/web/src/proxy.ts`'s Clerk `isPublicRoute` matcher never
included `/privacy`, so in `AUTH_MODE=production` an unauthenticated visitor
clicking "Privacy notice" from the public landing page was redirected to
sign-in instead of reading the notice — the opposite of what a privacy
notice is for. `AUTH_MODE=development` (used by every local/CI/e2e run) never
applies this middleware at all, which is why no existing test caught it.
Fixed by adding `/privacy` alongside `/`, `/sign-in(.*)`, and `/sign-up(.*)`.
The privacy notice itself (`/privacy`, shipped in Milestone 4 Task 2) was
otherwise complete and accurate; it was just unreachable from inside the
authenticated app, so `/account` gained a "Privacy notice" link next to
"Usage and cost" on both the Clerk and development account pages.
`/scans`, `/privacy`, and the batch page (via a new axe check in
`scan-flow.e2e.ts`, at the point the existing two-record test is already
sitting on `/scans/batch/{batchId}` with everything finished) now run the
zero-WCAG-2-A/AA-violations check in `accessibility.e2e.ts`, alongside the
existing dashboard/scan/collection/wishlist/account/discover/favorites/
playlists routes; `/privacy` was also added to the 360px no-overflow check.
Verified: `lint`, `typecheck`, `test` (329/329, unchanged — no contract
change), `format:check` on every changed file with `--end-of-line auto`,
`npm run build`, and `npm run test:e2e` (mobile Chromium).

Exit: tests find/export records beyond a 100-item fixture, paginate without
duplicates, and verify copy mutations/audit protection. All four browser profiles
and accessibility checks pass. At least four of five participants complete every
listed task without coaching; fix and retest blocking failures.

### P3.5 — Reproducible performance, delivery, and cost baseline

- [x] **Task 1.** First reconcile persistent monthly spend: development, both retained Aurora
      data planes/foundations, storage/backups/logging, capped aggregate AI usage,
      and a declared number of staging activation hours. State production rehearsal
      hours separately. Reconcile the $20 per-user AI default with a $25 total
      monthly target; alarms are not spending caps. If projected total exceeds
      $25, reduce scope/hours/allowances or record a revised budget decision before
      adding recurring infrastructure. (2026-09-17)
- [x] **Task 2.** Commit benchmark scripts and sanitized results specifying commit,
      hardware/tier, dataset, multiple synthetic users and batches, cache state,
      warmup, sample counts, concurrency, and at least three repeated runs. Avoid
      measuring only one user's quota lock or one batch-row lock. (2026-09-17)
- [x] **Task 3.** Measure API p50/p95, error rate, upload/normalization, queue age, attempt
      duration, end-to-end latency, throughput, and estimated AI cost. Reconcile
      signals with `OPERATIONS.md`; reuse persisted attempts and optional queue
      CloudWatch metrics. Use structured logs/Logs Insights for new timings and
      include telemetry retention/cost rather than adding uncosted custom metrics.
      (2026-09-18)
- [x] **Task 4.** Separate deterministic provider-stub runs from a small capped live run.
      Hold total provider concurrency constant for one/multiple-worker tests;
      separate application time from provider time. (2026-09-18)
- [x] **Task 5.** Introduce affected-workspace build/test selection with dependency closure
      and conservative full-check fallback. Record the tooling decision before
      adoption. Measure clean/cached builds before and after this optimization so
      Phase 4 does not attribute its gains to extraction. (2026-09-18)

Task 1 completed 2026-09-17. Full detail, method, and every figure below are in
`docs/OPERATIONS.md`'s "Reconciled monthly budget (P3.5 Task 1)" section,
built from real AWS Cost Explorer pulls and live resource state (not
list-price estimates) after the maintainer reauthenticated an expired AWS CLI
session so this session could use real figures. Headline result: the tension
`docs/PHASE_3_4_PLAN_REVIEW.md` flagged — a $20 per-user AI default consuming
80% of the $25 target — turned out not to exist in the real deployment.
`packages/config`'s `USER_MONTHLY_SPEND_LIMIT_USD` default is 20, but every
environment that can spend real money (development's Lambda via
`deploy-development.yml`'s injected env, staging and production via their
Terraform variable defaults) already overrides it to **5**; the 20 is reachable
only through a local `npm run dev` session with a manually-set real key, which
CLAUDE.md/AGENTS.md already discourage. Measured persistent baseline across
Secrets Manager (twelve secrets, not the nine a stale doc line claimed — a
real correction, `infra/terraform/development/main.tf`'s one `for_each`
resource creates four, not one), ECR image storage (a real, previously
undocumented cost, bounded by a live 20-image-per-repo lifecycle policy),
Aurora storage, S3, and CloudWatch Logs is ~$5.60/month from six clean
non-activation days. Reconciled total at current single-tester,
pre-public-usage scale: $5.60 baseline + $5 AI ceiling = $10.60/month steady
state, with $14.40/month of headroom before any staging/production
activation. Staging activation measured at ~$0.30-0.45 per full lifecycle run
from real historical `deploy-staging.yml` runs; declared allowance is up to
10 hours/month. Production rehearsal hours are stated separately per the
task's own requirement: all five historical `deploy-production.yml` attempts
failed before completing (gated on issues #8/#9/#10), so no real per-hour
figure exists yet — only a planning-level rate-card estimate. Projected total
in a month using both declared allowances is ~$21/month, under $25 with
margin; **no scope, hour, or allowance reduction was needed** — the fix was
correcting which AI-cap number was real, not cutting anything. Also found and
excluded: this AWS account carries non-VinylHound resources (a pre-existing
`siliconforest.io` Route 53 zone/registration and an unreferenced ~$3.72/month
Lightsail charge with no Terraform source, flagged to the maintainer to
confirm/cancel) that would have inflated the reconciliation if left in.
Left explicitly unresolved rather than guessed at: where the development
database is hosted/billed (external to these Terraform roots; identifying the
provider would have meant reading a stored secret, which this session's own
safety controls correctly blocked) and real historical OpenAI spend (no
billing API access from this session — the $5 figure used throughout is the
enforced ceiling, not measured actual spend). Both are carried forward for
whoever picks up next.

Task 2 completed 2026-09-17: `scripts/benchmark/` (`npm run bench:load`, see
its `README.md`) drives the real HTTP API — batch create, scan create, signed
upload, a real MinIO PUT, upload completion (readback/validate/normalize),
and submit — against a local production standalone build, with every batch
owned by one of several distinct synthetic users and every run using fresh
random user IDs, specifically so `enforceScanQuota`'s
`pg_advisory_xact_lock(hashtext(userId))` and `createOrGetScan`'s batch-row
`SELECT ... FOR UPDATE` (`packages/database/src/scan-repository.ts`) are
exercised across many independent lock targets rather than one, per
`docs/PHASE_3_4_PLAN_REVIEW.md`'s explicit warning about that confound. The
worker under test is `apps/worker/src/e2e-worker.ts` (the same
synthetic-identifier worker the Playwright e2e suite uses), so the benchmark
makes zero billable OpenAI calls. Driving traffic as distinct synthetic users
required one small, explicitly gated product change: `AUTH_MODE=development`
previously resolved every request to the same fixed `DEVELOPMENT_USER_ID`
with no way to address a different user over HTTP.
`DEVELOPMENT_BENCH_USER_HEADER_ENABLED` (new config flag, default `false`,
never consulted when `AUTH_MODE=production`) lets `requireUserId`
(`apps/web/src/server/auth.ts`) honor an `X-Vinylhound-Bench-User-Id` header
instead; the benchmark sets it itself and no other caller does, so default
behavior for development, CI, and e2e is unchanged. Committed sanitized
results from three consecutive timed runs (5 users × 2 batches × 5 scans =
50 scans/run, concurrency 10, one discarded warmup pass, single long-lived
warm process across all runs) are in
`scripts/benchmark/results/2026-09-17T21-07-11-939Z/` (`report.json` and
`summary.md`): 150/150 scans succeeded, full-pipeline p50 ranged 320–363 ms
and p95 360–416 ms across the three runs, run-to-run throughput was
consistent (27.9–29.9 scans/s) on this maintainer's development laptop (not
a dedicated benchmark machine — absolute numbers are illustrative, not a
performance claim). Deeper metric reconciliation against `OPERATIONS.md`,
provider-stub-versus-live-run separation, and worker-concurrency comparisons
are explicitly out of scope here and remain Tasks 3 and 4. Verified `lint`,
`typecheck` (added `scripts/benchmark/**/*.ts` to the root `tsconfig.json`
project so the benchmark is typechecked like application code), `test`
(329/329, unchanged), `build`, and `test:e2e` mobile-chromium (31/32, the
same pre-existing `live-camera` flake every prior session has also hit on a
clean tree) to confirm the `auth.ts` change didn't regress the existing
unauthenticated dev-mode path.

Task 3 completed 2026-09-18. Full detail, method, and every figure are in
`docs/OPERATIONS.md`'s new "Reconciled performance and cost signals (P3.5
Task 3)" section; only the headline is repeated here. Two real sources, both
gated on the same AWS CLI reauthentication P3.5 Task 1 needed (the session
was expired again at start; the maintainer reauthenticated live): a new
`scripts/metrics/reconcile.ts` (`npm run metrics:reconcile`, committed
sanitized run under `scripts/metrics/results/`) reads real persisted
`scan_attempts`/`outbox_messages` rows for attempt duration, queue age,
end-to-end latency, error rate, and estimated AI cost (69 real local attempts
found, 67 genuine `gpt-5.6-terra` calls: duration p50 3293ms/p95 16329ms,
error rate 0, $0.2757 estimated cost across 62,597+12,540 tokens — real local
`npm run dev` usage, not the deployed Lambda's own spend, which stays an open
unknown per Task 1); and CloudWatch Logs Insights against the live
development Lambda's real logs (111 real `http_request` events, 0 errors,
overall p50 621ms/p95 1112ms plus a by-route breakdown; 6 real
`upload_complete_timing` events; 4 real `scan_analysis_timing` events showing
real OpenAI call latency of 10–47 seconds, 2–9× slower than local and far
above the Task 2 synthetic benchmark's 320–416ms — expected, since that
benchmark's worker never calls a real provider).
Found and fixed a real, previously-undocumented bug while pulling the live
logs: `console.info("[web] http_request", fields)` (and the two other "new
timing" log lines from P3.1 Task 6) is not actually JSON-capable in the
Lambda runtime as `docs/OPERATIONS.md` claimed — Node's default multi-key
object inspection wraps onto several lines, and Lambda's log capture turns
each line into its own CloudWatch event, splitting one request's fields
across up to eight unrelated events and defeating both `grep` and Logs
Insights' automatic JSON field discovery. Fixed all three call sites
(`apps/web/src/server/http.ts`, the upload-complete route, both
`scan_analysis_timing` sites in `apps/worker/src/analysis-handler.ts`) to a
single `console.info(JSON.stringify({ event: "...", ...fields }))` call,
matching the convention `apps/worker/src/ops.ts`'s `drain_check`/
`queue_reconciliation` lines already used; documented the equivalent Logs
Insights queries for the fixed format in `OPERATIONS.md`. No test asserted
the old log shape (checked before changing it); `npm test` stayed at
332/332. Also documented, deliberately without enabling: native SQS
`ApproximateAgeOfOldestMessage`/`ApproximateNumberOfMessagesVisible` are
already alarmed and dashboarded (`infra/terraform/environment/monitoring.tf`,
`production/monitoring.tf`), satisfying "optional queue CloudWatch metrics"
with existing infrastructure; and `apps/worker/src/metrics.ts`'s custom
`PutMetricData` publisher (`CLOUDWATCH_METRICS_ENABLED`, previously
undocumented) stays off, since turning it on would add real,
unreconciled cost the persisted-attempt and native-SQS signals above already
make unnecessary — exactly the "reuse ... rather than adding uncosted custom
metrics" instruction. Verified `lint`, `typecheck`, `test` (332/332,
unchanged), `format:check` on every changed file with `--end-of-line auto`,
and `build`. Left uncommitted for the maintainer's review per this
repository's convention.

Task 4 completed 2026-09-18. Full detail is in `docs/OPERATIONS.md`'s new
"Deterministic-stub versus capped live run, and worker concurrency (P3.5
Task 4)" section; only the headline is repeated here. New
`scripts/concurrency/` (`npm run concurrency:compare`) drives the real HTTP
submission pipeline, then starts a configurable number of real worker
processes with `ANALYSIS_CONCURRENCY` split evenly across them, capturing
each process's `scan_analysis_timing` stdout line directly (now single-line
JSON thanks to the Task 3 fix) for the storage-fetch/provider-call split —
`scan_attempts` never persisted that split, only the bundled total, so
reading it from a controlled worker's own log output was the only way to get
it without a schema change. `mode=stub` runs the deterministic
`e2e-worker.ts` (free); `mode=live` runs the real `index.ts` against a real
`OPENAI_API_KEY`, refusing to start without one. Confirmed the live
portion's scope and cost with the maintainer via `AskUserQuestion` before
running it, given it makes real, billable calls — 10 real scans total
(5 scans × 2 worker-count legs), **actual cost $0.0298** (even cheaper than
the $0.05–0.20 pre-run estimate, since the tool's synthetic fixture image is
visually simpler than a real cover). Every leg holds total provider
concurrency at 2 regardless of worker count, so the worker-count comparison
isolates process-level parallelism from raw concurrency, per the task's
explicit requirement. Headline finding: `storageFetchDurationMs`
(application time) is 3–12ms in every leg, stub or live; real
`providerCallDurationMs` is 2.2–5.9 seconds (p50 ~3.1s) — **provider time is
essentially the entire attempt duration once a real call is involved**,
substantially faster than P3.5 Task 3's organic real-usage sample (10–47s)
because this tool's fixture is a flat synthetic image with nothing to
describe, not a real cover — explicitly documented as a floor, not a
realistic cost estimate. 1 worker modestly outperformed 2 workers at fixed
total concurrency in the live legs (27.1 vs 22.8 scans/min) but the stub
legs showed no real difference (1498 vs 1489 scans/min) and 5 real samples
per leg is far too few to call the live difference reliable — recorded as a
real observation, not a settled result. Found and fixed one real bug in the
tool itself before the confirmed live run, not in application code: an
initial 30-scans-per-leg smoke test hung for over 10 minutes because
`submitScans` put every scan in one batch, silently exceeding
`MAX_SCANS_PER_BATCH` (20) past scan 20 — fixed to spread scans across as
many batches as needed (now importing the real `MAX_SCANS_PER_BATCH` from
`@vinylhound/contracts` rather than a duplicated literal), confirmed against
a 25-scan run before trusting the tool with real billing. Also fixed, while
building the tool: the web server process was receiving a real
`OPENAI_API_KEY` in its env for `mode=live` even though `apps/web` never
calls the AI provider, a real (if inert) violation of AGENTS.md's "apps/web
... must never contain provider secrets" boundary — the web server now
always starts with the stub (empty-key) env regardless of which worker
modes run. Verified `lint`, `typecheck`, `test` (332/332, unchanged — no
contract touched), `format:check` on every changed/new file with
`--end-of-line auto`, and `build`. Left uncommitted for the maintainer's
review per this repository's convention.

Task 5 completed 2026-09-18. New `scripts/affected/` (`npm run test:affected` /
`npm run build:affected`, full method in its own `README.md`) scopes
`vitest`/the workspace build to a change's affected workspaces — those with a
directly changed file, closed transitively over their dependents — computed
from `git diff` plus each `package.json`'s internal `@vinylhound/*`
dependencies, rebuilt fresh every run. Any changed path outside a known
workspace and outside an explicit documentation/infra/CI safe-ignore list
conservatively forces the existing full `npm test`/`npm run build` unchanged;
so does no resolvable base commit. **Tooling decision, recorded before
adoption** (full rationale in `docs/OPERATIONS.md`): a small custom script
rather than adopting Nx or Turborepo, since this repository's eleven
workspaces and shallow dependency graph do not need a second
build-orchestration layer to get affected selection, and a hand-rolled
traversal is trivially unit-testable in isolation. 13 new unit tests cover
graph discovery, transitive closure (including a diamond dependency visited
once), and every classification rule; a dry run against the real repository
confirmed the expected real-world closures (a `packages/queue` change selects
only `{queue, worker}`; a `packages/contracts` change selects all eleven
workspaces, since contracts sits at the graph's root; a `docs/`-only change
selects nothing). Adopted into CI (`.github/workflows/ci.yml`, confirmed with
the maintainer first since it changes the shared gate), not left opt-in-only:
`npm run check` is unbundled into full `format:check`/`lint`/`typecheck`
steps (TypeScript compiles as one project with no project references, so
there is no cheaper subset to select there) plus a new affected-scoped test
step, and `npm run build` is replaced by an affected-scoped build step, both
resolving the same PR-base-or-pushed-over-commit ref the existing
contract-compatibility step already uses and falling back to the full command
identically to today whenever nothing resolves. Local `npm run check`/`npm
run build` (what `AGENTS.md` documents running before a handoff) are
themselves unchanged. Clean/cached builds and tests were measured before this
adoption, per the task's own requirement that Phase 4 not misattribute this
optimization's gains to service extraction: full `npm test` (345 tests, 37
files) took 3.3-3.8s versus 0.85-0.94s scoped to two affected workspaces
(~4x, dominated by fixed per-file startup cost, not per-test work); full `npm
run build` took 20-27s versus 5.2-5.7s when the affected set excludes
`apps/web` and its `next build` entirely (a structural skip, not an
incremental speedup — neither `tsc` build here uses incremental mode). A
change touching `packages/contracts` or anything else near the graph's root
gets no benefit: the affected set is every workspace, identical in scope and
wall time to the full command. Full detail, the tooling-decision rationale,
and the timing table are in `docs/OPERATIONS.md`'s new "Affected-workspace
build/test selection (P3.5 Task 5)" section. Verified `lint`, `typecheck`,
`test` (345/345, +13 net new, no contract touched), `format:check` on every
changed/new file with `--end-of-line auto`, and `build`.

**P3.5 is complete — all five tasks are checked.** Phase 3's "reproducible
performance, delivery, and cost baseline" milestone is done; per the
roadmap's "Sequence and gates" section the stated sequence now moves to Phase
4 (measured service extraction, starting with P4.1 — extract discovery
first). P3.4 Task 4 (the five-participant usability test) remains open
independent of this sequencing and should still be picked up when a
maintainer is available to run it.

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

- [x] **Task 1.** Use P3.5 evidence and ADR-0009's shared catalog coordination requirement to
      record the reason to extract, expected benefit, cost, and rollback path.
- [x] **Task 2.** Move provider adapters, bounded cache, and rate coordination behind an
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

Task 1 completed 2026-09-18 (ADR-0025). The proceed decision rests on
ADR-0009's unmet shared-limiter/cache requirement (both MusicBrainz's
one-second limiter and Spotify's per-process token/cache are still
closure-scoped to a single process) rather than on measured load: P3.5's
benchmark, concurrency comparison, and live CloudWatch sample all drove or
observed the scan pipeline, and recorded no `catalog.*`/`discovery.*` route
at all. Scope is narrowed per the plan review's G6/G9 suggestions: discovery
stays stateless (adapters, cache, rate/token coordination only; canonical
`albums`/`releases`/`catalog_references` stay with core, restated formally by
Task 3), and only staging/production receive the extracted service —
development keeps the in-process adapter behind the same port, which is also
the rollback path (redeploy the previous `apps/web` image; discovery owns no
canonical rows to reconcile). Cost is named, not estimated away: a fourth ECR
repository and IAM role, a new authenticated internal API, and the
coordination substrate itself is left to Task 4's own ADR — this decision
rules out adding ElastiCache by default (no Redis/ElastiCache exists in
`infra/terraform` today) but does not choose between a single replica and a
PostgreSQL-backed lease.

Task 2 completed 2026-09-18: a new `apps/discovery` standalone service now
hosts the `packages/catalog` MusicBrainz/Spotify adapters unchanged, behind
five routes (`GET /internal/v1/catalog/releases` and its `/{releaseId}` detail
route, `GET /internal/v1/discovery/search`, `/discovery/artists/{id}`, and
`/discovery/albums/{id}`) plus an unauthenticated `/healthz`. Browser traffic
is unaffected: it still only ever reaches `apps/web`'s existing `/api/v1/
catalog/*` and `/api/v1/discovery/*` routes, which now select an
implementation of the _same_ `CatalogProvider`/`DiscoveryProvider` port
interfaces (`packages/catalog`) at construction time
(`apps/web/src/server/context.ts`) — the in-process adapters when
`DISCOVERY_SERVICE_URL` is unset (development, per ADR-0025's tier scope), or
a new HTTP client (`createRemoteCatalogClient`/`createRemoteDiscoveryClient`)
when it is set. Every remote call carries a signed, 30-second-lived token
(new `packages/service-auth`, `signServiceRequest`/`verifyServiceRequest`,
HMAC-SHA256 over `node:crypto` — no new dependency) binding the specific
authenticated `userId` `requireUserId` already resolved, so the port
interfaces themselves gained a required `userId` field on every method's
input rather than that identity being smuggled in some other way. This is
the "service identity and user authorization, not just a user-ID header" the
task asked for: only a holder of the shared secret (`apps/web`) can produce a
valid signature, and the signature binds a specific user, expiring before it
could be meaningfully replayed. `apps/discovery` re-throws the identical
`CatalogProviderError`/`DiscoveryProviderError` types the in-process adapters
throw (recovered from a `catalog_<category>`/`discovery_<category>` wire
error code shared with `apps/web`'s existing `errorResponse` via new
`catalogProviderErrorStatus`/`discoveryProviderErrorStatus` helpers in
`packages/catalog`), so `apps/web/src/server/http.ts` needed zero changes
regardless of which implementation is wired up. `apps/discovery` is a plain
Node app (Fetch `Request`/`Response`, no framework dependency, mirroring
`apps/web`'s own `withRoute`/`errorResponse` shape) so route logic reads the
same in both apps; a small `node:http` bridge in `server.ts` is the only
Node-specific code. Verified with 90 new unit tests (`service-auth` token
round-trip/tamper/expiry, both remote clients against a mocked `fetch`,
`apps/discovery`'s auth boundary and all five routes including the
`not_configured`/`not_found`/malformed-query paths) plus a real manual smoke
test: a live `apps/discovery` process rejected a missing, tampered, and
wrong-secret token with 401, and a validly signed request returned a real
MusicBrainz result end to end through the actual `node:http` server (not
just the in-memory dispatcher the unit tests exercise). `npm run build`
(including `apps/web`'s Next build, after adding
`@vinylhound/service-auth` to its `transpilePackages`) and the full
`lint`/`typecheck`/`test` suite (390/390) are clean. Explicitly out of scope
here, per the roadmap's own task split: containerizing `apps/discovery`,
ECR/IAM/staging delivery (Task 5), and the coordination substrate ADR
(Task 4) — this service does not yet run anywhere outside a developer's own
`npm run dev:discovery`.

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
