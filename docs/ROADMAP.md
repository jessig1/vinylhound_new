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

- [x] Choose database/migration tool and implement user/scan/image/attempt tables.
- [x] Add development identity, signed upload, server validation, and object-storage adapter.
- [x] Add durable enqueue/outbox and queue worker.
- [x] Call the OpenAI adapter, persist candidates/audit metadata, and poll scan status.
- [x] Build mobile capture/upload, result review/correction, and add-to-list UI.
- [x] Add provider-boundary and confirmation integration tests.
- [x] Add phone-sized end-to-end coverage for the capture-to-confirm path.
- [x] Validate Sol + `high` + prompt v2 manually and accept its artist/title
      quality for the early build. The formal private AI evaluation is deferred
      until public application usage or model/cost optimization (see P4.5).

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

- [x] Production authentication (ADR-0013): Clerk resolves session identity
      in `AUTH_MODE=production`, mapped to a local `users.id` via a new
      `clerk_user_id` column, provisioned just-in-time on first request.
      `AUTH_MODE=development` (the default) keeps today's single fixed user
      with no Clerk dependency, so local dev/CI/tests are unaffected.
- [x] Account export and deletion (ADR-0014): `GET /account/export` returns
      every row a user owns as JSON (metadata only, no image bytes).
      `DELETE /account` performs an ordered hard delete — the user's
      `scan_confirmations` rows first (satisfying their deliberate `restrict`
      FKs, ADR-0011), then the `users` row and its cascades — and
      best-effort deletes the corresponding S3 objects. Shared catalog rows
      (`albums`/`releases`) are never touched. A privacy/retention policy is
      documented in `docs/SECURITY.md`; a user-facing privacy notice is
      still needed.
- [x] Managed-infrastructure operational readiness: the deployment topology,
      managed service requirements, backup retention, and monthly restore drill
      are documented in `docs/OPERATIONS.md`; `npm run ops:restore-test`
      verifies a local logical PostgreSQL backup against an isolated restore
      database. Public health (`/api/healthz`) and database readiness
      (`/api/readyz`) endpoints support service monitoring. Transactional
      per-user daily-analysis, active-scan, and rolling-spend controls reserve
      budget before initial jobs and retries enter the outbox; production must
      configure the related environment limits and provider-side spend cap.
- [x] Accessibility and cross-device browser test matrix: WCAG 2 A/AA checks
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

- [x] Add the MIT license, contribution and support guides, code of conduct,
      private security-reporting policy, guided issue forms, pull-request
      template, CODEOWNERS, labels, and release-note configuration.
- [x] Document the project status, limitations, public-history audit, contributor
      workflow, and GitHub repository settings.
- [x] Provide an idempotent GitHub configuration script for Discussions,
      security features, branch protection, merge policy, and labels.
- [x] Rotate the credential found by the 2026-09-02 audit and delete its sole
      containing experimental branch; `main` was never affected.
- [x] Push the workflows and obtain a clean full-history Gitleaks run.
- [x] Make the repository public.
- [x] Apply and verify GitHub security settings and branch protection:
      `scripts/configure-github-repository.sh` enables secret scanning/push
      protection, vulnerability alerts, automated security fixes, private
      vulnerability reporting, read-only default workflow permissions, labels,
      and `main` branch protection (required status checks, linear history, no
      force-push/deletion, required conversation resolution). Verified live via
      the GitHub API on 2026-09-07.
- [ ] Rehearse an untrusted fork pull request: confirm a read-only token, no
      AWS OIDC role, no GitHub environment/provider secret exposure, required
      checks still run on fork code, and no `pull_request_target` execution.

### P2.2 — Production runtime and container readiness

- [x] Add pinned, minimal, non-root web and worker images with ARM64 support,
      standalone Next.js output, health checks, and graceful shutdown.
- [x] Remove build-time secret embedding; use Lambda/ECS/EKS role credentials
      by default and configurable bounded/TLS database connections.
- [x] Add PR image builds, SBOM generation, and vulnerability gates.
- [x] Deploy the development Lambda runtime in AWS and pass its live HTTP health
      and readiness checks.
- [ ] Complete the remaining Lambda asynchronous-path, Fargate, and EKS
      runtime/shutdown demonstrations in the AWS account.

### P2.3 — Terraform foundation and isolated environments

- [x] Add the encrypted/versioned state and ECR bootstrap root with repository-
      scoped GitHub OIDC roles.
- [x] Add independently keyed always-live serverless development, just-in-time
      ECS staging, and just-in-time EKS production roots with isolated S3,
      PostgreSQL, SQS, secrets, DNS/TLS, telemetry, budgets, and IAM.
- [x] Make staging/production runtime resources conditional through
      `environment_active` while retaining their data planes.
- [x] Bootstrap the target account and apply the development environment.
- [x] Review real staging/production plans and apply their inactive foundations:
      both roots' persistent foundations (VPC, ACM validation, Aurora, S3, SQS,
      secrets) have been applied and confirmed multiple times this session,
      including the production teardown that resolved the 2026-09-07 incident
      (issues #9, #10).

### P2.4 — GitHub Actions delivery and just-in-time lifecycle

- [x] Add PR platform/Kubernetes checks, immutable ARM image publishing,
      automatic development and staging delivery, one-off migrations,
      staged-image promotion, manual bounded EKS production activation, hourly
      expiry cleanup, and safe production drain.
- [x] Add operational drain checking, idempotent queue reconciliation, and cost
      preflight commands.
- [x] Create all three GitHub environments and configure development OIDC
      variables.
- [x] Correct the repository plan variables (`AWS_PLAN_ROLE_ARN` is a real IAM
      role ARN; `APP_HOSTNAME` is a real FQDN) and configure staging/production
      OIDC variables.
- [x] Complete two consecutive staging lifecycle runs: `34080493765` (commit
      `506767e`) and `34081530170` (commit `413fc5f`) both activated
      infrastructure, migrated, deployed, passed HTTP smoke checks, tagged
      `staging-passed-<sha>`, and deactivated cleanly on 2026-09-07.

### P2.5 — Scaling, security, observability, and cost controls

- [x] Encode distinct Lambda/ECS/Pod Identity roles, worker-only OpenAI access,
      web/worker scaling limits, log retention, SQS alarms, WAF, SNS, and
      environment budgets.
- [x] Refuse normal production activation beyond $20 unless a break-glass input
      is supplied.
- [x] Document the threat model, incident response, backup/restore, and inactive
      cost model.
- [ ] Execute load, failure, authorization, restore, and teardown drills.

### P2.6 — Production rehearsal and completion

- [ ] Rehearse sign-in, signed upload, AI review, collection/export/deletion,
      scaling, Spot replacement, rollback, reconciliation, cold resume/PITR,
      deactivate/reactivate, expiry cleanup, and an untrusted fork PR.
- [ ] Publish sanitized architecture, CI/CD, contribution, cost, threat-model,
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

- [x] Rewrite `/scan` as an extracted capture-session flow, replacing the one-shot
      mode-toggle control flow. Reuse independent scans and incremental membership
      in existing batches; that grouping needs no schema/API change. The web
      flow is intentionally upload-only and accepts one cover per record.
- [x] Add bounded upload concurrency, session queue, per-item progress,
      retry/cancel, and review-later navigation. Rehydrate persisted scans after
      refresh; clearly identify unuploaded local images as needing recapture.
- [x] Add an authenticated signed-thumbnail read endpoint with ownership checks,
      short TTL, private cache policy, expiry refresh, and safe missing/legacy
      image fallback. Reuse the thumbnails already generated in storage.
- [x] Add quota-headroom contracts/polling and an early admission check before
      expensive upload processing. Keep submission/retry quotas transactional:
      headroom is advisory under concurrency. Define abandoned-upload cleanup.
- [ ] Reconcile active-scan (20), batch (20), daily-attempt (100, including retries),
      and worker-concurrency (1) defaults. Define batch rollover, queue-pressure
      pause/resume, and daily/spend exhaustion behavior without retry loops.

Partial progress, 2026-09-09 (not enough to check the second box above):
`GET /quota` (advisory, unlocked) and an early admission check inside
`createOrGetScan` (also advisory) now exist, backed by a shared headroom
computation `enforceScanQuota` also uses, so the transactional submit/retry
check and every advisory read stay in sync by construction. The worker
cancels abandoned `awaiting_upload` scans (no scan/image activity within
`ABANDONED_UPLOAD_TTL_HOURS`, default 24h) on its own poll loop and
best-effort deletes their orphaned image objects. `/scan` polls headroom
before starting/resuming and after a `quota_exceeded` failure, disables
starting a session while blocked, and never auto-retries a quota failure —
it waits for headroom to return (polled every 20s) or for the user to retry
manually, satisfying "queue-pressure pause/resume" and "daily/spend
exhaustion... without retry loops" uniformly across all three quota
dimensions. `docs/OPERATIONS.md` now documents why active-scan (20)
deliberately equals batch (20) and why `ANALYSIS_CONCURRENCY` (worker
throughput) is independent of the per-user limits. Still outstanding: batch
rollover itself (a continuous session spanning more than one batch) is
deferred to P3.2's continuous-capture state machine rather than retrofitted
onto today's one-shot upload picker, which already hard-caps a session at
`MAX_SCANS_PER_BATCH` client-side and so never reaches the server-side batch
limit in normal use.

- [ ] Add structured web request/error timing and validated correlation IDs
      across HTTP, outbox/job payloads, and worker attempts. Preserve compatibility
      with queued jobs. Treat inbound IDs as untrusted metadata, never identity;
      exclude secrets, signed URLs, and image bytes. Time upload and normalization
      separately and reuse existing worker/attempt metrics.
- [ ] Inventory persistent spend before adding billable resources; carry known
      costs and unknowns into P3.5's reconciled budget artifact.

Exit: ten covers queue independently and persisted progress survives navigation
and refresh, with stored thumbnails and later review. Tests hit active/batch
ceilings, concurrent quota contention, 429 recovery, retry/cancel, and expired or
foreign-user image reads. A request is traceable through enqueue and analysis.
Daily/spend exhaustion stops capture until the relevant limit permits resumption.

### P3.2 — Guided automatic mobile capture

- [ ] Add opt-in live camera framing and a bounded state machine: armed, captured,
      disarmed, rearmed after removal/change. A held cover cannot repeatedly submit.
- [ ] Pause on quota/queue pressure, backgrounding, or lost camera access; release
      camera resources on exit. Preserve manual capture/file-input fallback for
      denial, unsupported browsers, and detection failures.
- [ ] Keep existing MIME-sniffing, HEIC rejection, multi-view, focus, and browser
      tests green. Canvas captures use supported JPEG/PNG.
- [ ] Automate state-machine tests with stubbed `getUserMedia`. Document a manual
      iPhone Safari and Android Chrome protocol recording device/OS/browser,
      lighting, captures, misses, duplicates, and interventions.

Exit: automated tests prove no duplicate while held, rearming, pause/resume, and
fallback. Each target phone captures at least nine of ten deliberate cover
presentations with zero duplicate submissions. Record sanitized device results;
browser emulation does not prove real-camera behavior.

### P3.3 — Discovery and saved music without scanning

- [ ] Add independent catalog search/details with provider provenance and clear
      release-concept versus pressing uncertainty. Keep MusicBrainz behind its
      port; another provider requires an ADR.
- [ ] Define contracts/domain rules before persistence/UI for release favorites
      and user-owned ordered playlists of saved release references. Include
      favorite/unfavorite and playlist create/rename/reorder/remove/delete.
      Playlists organize music; streaming playback is outside scope.
- [ ] Add reviewed, idempotent catalog-to-wishlist placement without scanning,
      using existing library deduplication rules and no invented image history.
      Include new saved-music data in account export/deletion.
- [ ] Establish explicit HTTP/event version conventions and previous-deployed-
      version compatibility fixtures in `packages/contracts`, building on
      `scan.analyze.v1`. Add catalog/usage coverage and CI compatibility checks;
      workspace version `0.1.0` is not a compatibility guarantee.

Exit: separate browser tests complete search/details, favorite/unfavorite,
playlist editing, and reviewed wishlist addition without a scan. Integration
tests cover ownership, deduplication, replay/conflict, and export/deletion.
Current/previous contract fixtures pass. If product scope is deferred, deliver
the compatibility foundation separately before Phase 4 extraction.

### P3.4 — Complete the everyday experience

- [ ] Replace search within the first 100 fetched rows with full-library search,
      stable cursor pagination/sorting, and export of all matching records.
      Preserve effective user-corrected artist/title matching and ordering.
- [ ] Complete per-copy condition/location/notes/acquisition-date editing and
      deletion, ownership checks, idempotency, and mutation feedback. Define
      last-copy rules explicitly and preserve confirmation audit history.
- [ ] Use P3.1 image reads in scan history and batch review navigation. Complete
      empty/loading/error states, accessible controls, and the privacy notice.
- [ ] Test five new participants on a fixed task list: capture/review a record,
      recover a failed scan, find an older library entry, and edit a copy.
      Record completion, assistance, and failures per task without personal data.

Partial progress, 2026-09-09 (not enough to check any box above): a library
item detail page at `/library/{itemId}` now carries per-copy editing with real
mutation feedback, notes editing, and removal, and P3.1 image reads are wired
into scan history and both library grids. Still outstanding for these items:
batch review navigation, explicit last-copy rules, full-library search and
pagination, Playwright coverage for the new page, and the participant testing.
Saved records became removable via ADR-0018, which supersedes ADR-0011's
delete restriction while preserving confirmation audit history.

Exit: tests find/export records beyond a 100-item fixture, paginate without
duplicates, and verify copy mutations/audit protection. All four browser profiles
and accessibility checks pass. At least four of five participants complete every
listed task without coaching; fix and retest blocking failures.

### P3.5 — Reproducible performance, delivery, and cost baseline

- [ ] First reconcile persistent monthly spend: development, both retained Aurora
      data planes/foundations, storage/backups/logging, capped aggregate AI usage,
      and a declared number of staging activation hours. State production rehearsal
      hours separately. Reconcile the $20 per-user AI default with a $25 total
      monthly target; alarms are not spending caps. If projected total exceeds
      $25, reduce scope/hours/allowances or record a revised budget decision before
      adding recurring infrastructure.
- [ ] Commit benchmark scripts and sanitized results specifying commit,
      hardware/tier, dataset, multiple synthetic users and batches, cache state,
      warmup, sample counts, concurrency, and at least three repeated runs. Avoid
      measuring only one user's quota lock or one batch-row lock.
- [ ] Measure API p50/p95, error rate, upload/normalization, queue age, attempt
      duration, end-to-end latency, throughput, and estimated AI cost. Reconcile
      signals with `OPERATIONS.md`; reuse persisted attempts and optional queue
      CloudWatch metrics. Use structured logs/Logs Insights for new timings and
      include telemetry retention/cost rather than adding uncosted custom metrics.
- [ ] Separate deterministic provider-stub runs from a small capped live run.
      Hold total provider concurrency constant for one/multiple-worker tests;
      separate application time from provider time.
- [ ] Introduce affected-workspace build/test selection with dependency closure
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

- [ ] Use P3.5 evidence and ADR-0009's shared catalog coordination requirement to
      record the reason to extract, expected benefit, cost, and rollback path.
- [ ] Move provider adapters, bounded cache, and rate coordination behind an
      authenticated internal discovery API. Browser traffic stays behind web;
      require service identity and user authorization, not just a user-ID header.
- [ ] Keep canonical `albums`, `releases`, and `catalog_references` with the
      core/library and its transaction. Discovery owns no canonical records;
      cache data is disposable.
- [ ] Decide the coordination substrate in an ADR: PostgreSQL-backed cache/rate
      lease for replicas, or a single discovery replica with explicit availability
      and rollout constraints preventing overlapping independent limiters.
      Per-process Maps cannot enforce a global provider limit. AWS Redis does not
      exist today; ElastiCache requires an explicit budget decision.
- [ ] Add service image/ECR/IAM/configuration and staging ECS delivery; prepare
      gated production EKS definitions and retain development's in-process port.
      Test bounded retries, timeouts, failures, and contract compatibility.

Exit: deploy and roll back a discovery-only change in staging without rebuilding
web/worker. Demonstrate bounded cache and provider-wide rate coordination under
concurrent callers and rollout conditions. Compare P3.5's relevant workload and
record proceed, retain-in-process, or rollback before starting P4.2.

### P4.2 — Extract scans and asynchronous confirmation

- [ ] Define scan ownership of scans/images/attempts/reviewed confirmations and
      core ownership of catalog/library/copies/favorites/playlists. Initially keep
      one physical PostgreSQL deployment with separate schemas and credentials,
      no cross-service table access, and a documented shared failure boundary.
- [ ] Generalize the outbox in a separate migration/refactor: aggregate type/ID,
      topic/version, dedupe key, correlation, and topic-aware dispatch. Remove the
      scan-only FK/topic CHECK and mandatory attempt-number assumption. Preserve
      skip-locked claiming, backoff, and replay safety; scope cancellation checks
      to analysis messages.
- [ ] Supersede ADR-0005 at cutover: one scan transaction stores the reviewed
      confirmation and versioned event. A core consumer atomically records an
      inbox dedupe receipt, catalog/library changes, and completion event; scan
      consumes completion into a projection. No cross-service dual writes.
- [ ] Specify same-key/same-payload replay and same-key/different-payload conflict.
      Duplicate delivery cannot create another physical copy; a genuinely new
      reviewed scan may. Show `Saving` until completion, then the stable library
      reference; expose delay/failure with safe retry and reconciliation.
- [ ] Isolate or fairly schedule confirmation dispatch so analysis cannot starve
      it. Set a confirmation-to-library latency target before implementation and
      include the existing outbox poller's delay in the measurement.
- [ ] Replace the cross-boundary confirmation/library restrict FK with explicit
      application invariants and durable audit references/projections. Record the
      policy in an ADR and preserve protected-history behavior unless explicitly
      changed. Make account export/deletion a durable, authenticated, retryable
      workflow; late events must not recreate deleted account data.
- [ ] Use additive migrations, backfill, verification, then a single writer switch.
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

- [ ] After a working staging extraction, move platform configuration/delivery
      into a dedicated platform repository. Keep immutable service-specific
      application artifacts, narrow OIDC roles, previous-contract compatibility,
      and Phase 3 affected-workspace improvements.
- [ ] Inventory the four Terraform roots (`bootstrap`, `development`,
      `environment`, `production`), backend keys, locks, IAM trust, configuration,
      and owning workflows. Close #9/#10 before any ownership transfer.
- [ ] Rehearse development first: freeze the old writer, back up/version state,
      transfer configuration/workflow authority, verify an unchanged plan against
      the existing backend, then enable exactly one new writer. Transfer remaining
      roots individually with the same verification and rollback instructions.
      Do not recreate resources or create competing state authorities. Recover
      locks only with verified ownership and no active apply.
- [ ] Demonstrate independent service delivery, scaling, health, migration,
      rollback, and activation/deactivation in staging. Keep production rehearsal
      gated on the unresolved Phase 2 issues.

Exit: evidence identifies one authorized writer per root, unchanged resource
identity, no unexpected replacements, and a rehearsed transfer rollback. A
service-only release builds/deploys/rolls back without rebuilding unrelated
services. Record gated production demonstrations as outstanding.

### P4.4 — Verify benefits and costs against the monolith

- [ ] Run P3.5 benchmark scripts unmodified against the extracted topology,
      changing only documented target/configuration inputs. Match workload,
      resources, cache, user/batch distribution, and total provider concurrency;
      identify unavoidable differences explicitly.
- [ ] Exercise isolated scaling, discovery/provider outage, scan backlog, delayed
      confirmation, and service rollback. Test unrelated library journeys where
      dependencies permit. PostgreSQL failure remains a shared failure boundary.
- [ ] Compare latency distributions, throughput, errors, confirmation delay,
      build/deploy time, operational steps, and monthly cost against P3.5's
      declared budgets. Separate provider variance and earlier CI gains.

Exit: publish reproducible before/after samples and a keep/revise/reverse decision
for each extraction. Explain and address failed budgets before calling the
topology ready. Finding that the monolith is sufficient is a valid evaluation
result; unrun demonstrations are not completed work.

### P4.5 — Private data and AI baseline

- [ ] Use the existing private eval runner with consented images, maintainer-
      verified labels, development/held-out separation, and model/prompt versions.
      Keep private images and unverified labels out of the public repository.
- [ ] Before running, fix sample composition and acceptance thresholds for artist/
      title rank-1/top-3 accuracy, pressing evidence separately, review routing,
      schema/provider errors, latency, tokens, and cost. Include difficult covers
      and multi-view cases; report counts and uncertainty.
- [ ] Run the capped baseline, retain reproducible private artifacts, and publish
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
