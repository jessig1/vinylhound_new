# Phase 3-4 plan review

Reviewed 2026-09-08 at the maintainer's request. Scope: the proposed Phase 3-4
plan ("Product maturity and measured service extraction"), evaluated for clarity
of goals and outcomes and for agreement with the repository as it actually
stands. No code, contracts, migrations, or infrastructure were modified.

The plan being reviewed is a draft held by the maintainer; it is not yet a file
in this repository. This document records the findings so the roadmap rewrite
that follows can start from an agreed picture rather than from the draft's own
assumptions.

## Scope and method

Claims were verified against code rather than against `docs/ROADMAP.md` and
`docs/HANDOFF.md` alone, per the outside-evaluation role in `CLAUDE.md`.
Findings are ordered errors, then gaps, then suggestions.

Examined: the scan capture UI and batch flow, the scan/upload/submit routes, the
quota implementation, `packages/catalog`, the confirmation transaction,
`packages/contracts`, the migrations and schema, the outbox, the Playwright
suites, and the logging/metrics surface.

Not examined: the Terraform roots in detail (only ownership, topology, and the
absence of a shared cache), the GitHub workflow YAML internals, `packages/evals`,
and the production Kubernetes manifests beyond their file list.

## Verdict

The plan's thesis is sound and unusually honest: evolve the architecture from
product need and measurement, and accept that the monolith may win. The Phase 4
scan-extraction contract - outbox, idempotent consumption, completion
projection, a `Saving` UI state, duplicate and key-conflict rules - is the
strongest section. Nothing better is proposed for its design; it rests on one
unstated prerequisite (G8) and one unstated ownership decision (G9).

The weaknesses are all of one kind: several exit criteria cannot be failed, and
several deliverables depend on code that does not exist yet and is not named.
Both are fixable without changing the plan's direction.

## Errors: statements that conflict with the repository

### E1. "Phase 2 remains delivered with tracked exceptions" overstates the state

`docs/HANDOFF.md:461-465` records that Phase 2 was deliberately not marked
complete and not tagged, and `docs/ROADMAP.md:140`, `:153`, `:199`, `:204-207`
leave P2.1/P2.2/P2.5/P2.6 unchecked. Issue #8, the production ALB/CloudFront 504,
is a hard blocker: production has never served an end-to-end request.

This matters to Phase 4, not only to wording. P4.3 and P4.4 exit on deploying one
changed service without rebuilding unrelated services, and on exercising isolated
scaling, failure, and rollback. Those need a runtime that works.

Suggestion: name the measurement and demonstration environment. Staging is the
only tier that has completed a full lifecycle (`docs/HANDOFF.md:470-475`, commit
`beeb98a`, run `34158399023`). State that Phase 4 demonstrations run in
staging/ECS and that production rehearsal stays gated on #8 and #9, rather than
letting the plan imply Phase 2 is behind it.

### E2. The $25 target does not compose with the numbers already in the repository

- Production already carries a $25 budget alarm with 40/60/80/100% thresholds,
  and development $10 (`docs/OPERATIONS.md:185`).
- `USER_MONTHLY_SPEND_LIMIT_USD` defaults to 20
  (`packages/config/src/index.ts:83`, `.env.example:44`). One user's AI allowance
  alone is 80% of the whole target.
- Development is always live (`docs/HANDOFF.md:469`), and two Aurora clusters
  plus the VPC foundation persist by design (ADR-0016,
  `docs/HANDOFF.md:476-481`).

The plan already says to treat $25 as a budget constraint requiring verification
and to measure existing persistent costs first. That instinct is right, but it
sits in the validation section rather than gating anything.

Suggestion: make "measure current persistent monthly spend" the first P3.5
deliverable, with a stated denominator - persistent development, capped AI, and a
defined number of hours of staging activation - and reconcile the per-user AI cap
against the total in the same artifact.

### E3. "Reuse independent scans and existing batch grouping" understates P3.1

The server side is genuinely reusable, and this is worth stating loudly.
`createOrGetBatch` inserts only a `batches` row and takes no scan list
(`packages/database/src/scan-repository.ts:715-745`); membership is set per scan
through the optional `batchId` on `POST /scans`
(`packages/contracts/src/scan.ts:116-121`) and read dynamically
(`scan-repository.ts:747-765`). Incremental capture into an existing batch needs
no schema or API change.

The client is the opposite. `apps/web/src/app/scan/page.tsx` is a 708-line
one-shot form: `switchMode` destroys all selected images (`scan/page.tsx:78-86`),
and `identifyBatch` creates the batch and fans out every upload in a single
unbounded `Promise.allSettled` (`scan/page.tsx:250-293`) before navigating away.
Continuous capture inverts that control flow.

Suggestion: say "server contracts unchanged; `/scan` capture flow rewritten and
extracted from the mode-toggle form" so P3.1 is not estimated as a small change.

## Gaps: missing work that a stated exit criterion depends on

### G1. No image read path exists, which blocks P3.1 and not only P3.4

P3.1 promises a session queue and review-later flow and states that progress
survives navigation and refresh; P3.4 lists scan thumbnails. Nothing today can
display a stored image: there is no images route under
`apps/web/src/app/api/v1/`, and `createSignedReadUrl`
(`packages/storage/src/index.ts:31`, `s3-object-storage.ts:141`) has zero
production callers. Thumbnails have been written to S3 since ADR-0007 and nothing
reads them. `docs/UI_UX_REVIEW.md:23,56` already ranks this as needing its own
signed-image-lifecycle review.

Suggestion: move a signed thumbnail read endpoint into P3.1's deliverables. The
storage primitive already exists; the missing pieces are the route, ownership
checks, and cache/TTL policy.

### G2. Quota is enforced after the expensive work, and there is nothing to poll

`enforceScanQuota` runs inside `submitScan`
(`packages/database/src/scan-repository.ts:369-447`, called at `:529-533`) -
after upload and server-side `sharp` normalization
(`apps/web/src/app/api/v1/scans/[scanId]/uploads/[imageId]/complete/route.ts:55-98`)
have already been paid for. `quota_exceeded` surfaces as 429
(`apps/web/src/server/http.ts:93-100`).

Two numbers collide under continuous capture. `USER_ACTIVE_SCAN_LIMIT` is 20
(`packages/config/src/index.ts:82`) and `MAX_SCANS_PER_BATCH` is 20
(`packages/contracts/src/batch.ts:9`), while `ANALYSIS_CONCURRENCY` defaults to 1
(`packages/config/src/index.ts:196`). A full 20-capture session sits exactly at
the active-scan ceiling, and anything concurrent returns 429.
`USER_DAILY_ANALYSIS_LIMIT` of 100 counts outbox rows, so retries consume it too
(`scan-repository.ts:378-398`) - a single shelf of records is one day's quota.

The plan's instruction to pause automatic capture when the queue or account quota
fills has no signal to read.

Suggestion: add a quota-headroom endpoint, or return remaining headroom from
`submit`, and revisit the four defaults as an explicit P3.1 deliverable.
Separately, P3.1's exit criterion of ten covers passes below every limit. Add a
criterion that the pause-and-resume path is exercised at the ceiling; that is the
behavior worth proving.

### G3. P3.2's exit criterion is not automatable on the stated target platform

`apps/web/playwright.config.ts:23-40` defines four projects including
`mobile-webkit` (iPhone 13), but sets no `permissions`, no `contextOptions`, and
no fake-media flags. Chromium can be driven with fake-device flags plus
`grantPermissions(["camera"])`. WebKit and Firefox have no equivalent, so iPhone
Safari automatic capture can only be covered by stubbing
`navigator.mediaDevices.getUserMedia` through `page.addInitScript`.

Replacing the file inputs also breaks existing coverage that selects on them:
`input[type="file"]:not([capture])` (`apps/web/e2e/scan-flow.e2e.ts:7`), the
`multiple`-on-capture assertion (`scan-flow.e2e.ts:130-133`), the MIME-sniffing
and HEIC-rejection tests (`scan-flow.e2e.ts:246-279`), and
`apps/web/e2e/accessibility.e2e.ts:33-40`, which iterates every file input on
`/scan` and asserts its label's focus outline.

Suggestion: split P3.2's exit criterion into an automated, stubbed-`getUserMedia`
check of the capture state machine (armed, captured, disarmed, rearmed, with no
repeat submission while a cover is held still) and a documented manual device
protocol producing the nine-of-ten artifact. Add "the manual-capture fallback
keeps the existing file-input path and its browser tests green" as a deliverable;
the plan already promises the fallback, so this costs nothing to state.

Incidental benefit worth capturing: canvas capture emits JPEG or PNG, which
sidesteps the iOS HEIC rejection path the suite currently tests.

### G4. Instrumentation is partial, and the missing half is the half Phase 4 needs

Three pieces already exist and the plan should build on them rather than restate
them:

- `apps/worker/src/metrics.ts:9-75` publishes `QueuePendingJobs`,
  `QueueOldestAgeSeconds`, and `QueueFailedJobs` to CloudWatch, gated by
  `CLOUDWATCH_METRICS_ENABLED` (default false,
  `packages/config/src/index.ts:197-199`). Queue age is already covered, and the
  cost knob already exists.
- `scan_attempts` persists `durationMs`, `inputTokens`, `outputTokens`, and
  `totalTokens` (`packages/database/src/schema.ts:317-320`, written at
  `apps/worker/src/analysis-handler.ts:48,86,112`). Analysis duration and cost
  percentiles are queryable from PostgreSQL today.
- `docs/OPERATIONS.md:155-166` already names the intended signals, including
  queue age over five minutes, outbox publish failures, and p95 attempt-duration
  regressions.

What is genuinely missing is everything on the web side: no request or response
access log, no latency log, and no per-route instrumentation. There are only two
`console` call sites in the entire web application
(`apps/web/src/server/http.ts:82-85` and
`apps/web/src/app/api/v1/account/route.ts:23`). API p50/p95, error rate, and
upload duration have nothing behind them.

More consequential for Phase 4: `createRequestId()`
(`apps/web/src/server/http.ts:26-28`) mints a fresh UUID per route invocation. It
is never read from an inbound header, never forwarded to the worker, and never
stored on a row. There is no correlation mechanism to trace a request across a
process boundary, which is precisely what P4.4 needs in order to separate
application latency from provider latency.

Suggestion: put two things in P3.1's deliverable column - web-side request timing
and correlation-ID propagation (accept an inbound `x-request-id` and forward it
onto the outbox row and the job payload). Correlation is far cheaper to add
before the extraction than after. Reconcile P3.5's metric list with
`docs/OPERATIONS.md:155-166` rather than inventing a parallel one, and name the
sink: structured logs plus Logs Insights is budget-compatible, whereas additional
CloudWatch custom metrics are billed per metric per environment against a $25
ceiling.

### G5. Discovery's cache and rate coordination have no shared substrate

`packages/catalog/src/musicbrainz-catalog.ts` holds an unbounded per-process
`Map` cache with a 24-hour TTL (`:85-88`, `:129-132`) and a promise-chain limiter
spacing requests one second apart (`:80-84`, `:259-282`). Both are closure
scoped: the one-request-per-second guarantee holds only because exactly one web
process exists today.

The plan should cite the existing commitment here rather than arguing from first
principles. `docs/decisions/0009-musicbrainz-primary-catalog.md:50-52` already
states that catalog lookups need a shared limiter, cache, and asynchronous
execution. That is the product-need justification P4.1 is looking for, and it
predates this plan, which strengthens the thesis considerably.

The read path itself is cheap to extract: `CatalogProvider` is a single-method
port (`packages/catalog/src/catalog-provider.ts:9-13`) with one call site
(`apps/web/src/app/api/v1/catalog/releases/route.ts:42`), constructed in one
place (`apps/web/src/server/context.ts:40-42`), and `CatalogProviderError`
already maps to HTTP status (`apps/web/src/server/http.ts:102-109`).

What is unresolved is the shared substrate. There is no Redis or ElastiCache in
any AWS root - zero matches across `infra/terraform` - and ADR-0016 keeps
BullMQ/Redis local only.

Suggestion: decide this in P4.1 and record it as an ADR. Either pin discovery to
a single replica and document the availability tradeoff honestly, or back the
cache and rate lease with PostgreSQL. ElastiCache is a real budget line and
should not be adopted by accident. A single-replica discovery service still makes
P4.1's exit criterion - deploy or roll back discovery without rebuilding web or
worker - fully demonstrable, so the cheap option costs the plan nothing.

### G6. Each extracted service must be built three times

The plan's instruction to keep the existing runtime tiers and add no new hosting
platform reads as cost containment, but those tiers are three different shapes:
development is API Gateway plus Lambda, staging is ECS Fargate, and production is
EKS (ADR-0016, `docs/ARCHITECTURE.md:111-129`; `infra/kubernetes/production`
holds four manifests; `infra/terraform/environment` is ECS only). Two extracted
services across three shapes means new ECR repositories in `bootstrap` plus a
Lambda, an ECS service, and a Deployment with its own Pod Identity role, for
each.

Suggestion: state which tiers receive the extracted services. A defensible answer
is staging and production only, with development keeping discovery in process
behind the same port, which also preserves the scale-to-zero development cost
profile.

### G7. Contract versioning does not exist yet

`packages/contracts/src` is a flat barrel - `scan.ts`, `library.ts`,
`catalog.ts`, and so on - with no directories and no version folders, and the
compatibility fixtures described in `docs/TESTING.md:6` are not present; the
contract tests are schema tests. HTTP versioning is by URL path only. The only
precedent in the package is the job payload: `ANALYZE_SCAN_JOB =
"scan.analyze.v1"` plus `jobVersion: z.literal(1)`
(`packages/contracts/src/scan.ts:89,104`). Every workspace is pinned at `0.1.0`
and consumed by path, so there is no semver discipline to lean on either.
`catalog.ts` and `usage.ts` currently have no tests.

P4.2 requires a versioned event, and the CI/CD section requires compatibility
with the previous deployed version.

Suggestion: introduce the versioning and compatibility-fixture convention in
P3.3, where new discovery contracts are being added anyway, so Phase 4 is not
inventing it mid-extraction.

### G8. The existing outbox cannot carry a confirmation event without a migration

This is the one place where the plan's strongest section rests on an unstated
prerequisite. P4.2 says the scan service durably records the reviewed
confirmation and an outbox event. The existing outbox is excellent
infrastructure - `select ... for update skip locked`, exponential-backoff
deferral, `publishedAt` marking, deterministic idempotency keys
(`packages/database/src/scan-repository.ts:773-852`) - but it is hard-wired to
scan analysis in four places:

1. `outbox_messages.aggregate_id` is a foreign key directly to `scans.id`
   (`packages/database/src/schema.ts:177-179`).
2. A check constraint pins the topic to the single literal `'scan.analyze.v1'`
   (`schema.ts:205-208`,
   `packages/database/migrations/003_scan_submission_outbox.sql:22-23`).
3. `attempt_number` is not null with a unique index on
   `(topic, aggregate_id, attempt_number)` (`schema.ts:180,197-201`), a
   scan-analysis concept for which a confirmation event has no natural value.
4. The dispatcher runs `AnalyzeScanJobSchema.parse` on every row
   (`scan-repository.ts:818`), has no topic registry, performs a scan-status
   cancellation lookup for every message (`:796-799`), and lives inside
   `scan-repository.ts` rather than its own module.

None of this is an architectural flaw. The concurrency mechanics are already
right, and the producer pattern drops straight into `confirmScan`'s existing
transaction next to the `scanConfirmations` insert
(`packages/database/src/confirmation-repository.ts:372-399`). But generalizing it
is a real migration - `(aggregate_type, aggregate_id)` with the foreign key
dropped, a relaxed topic constraint, and a dedupe key replacing `attempt_number` -
plus a dispatcher refactor.

Suggestion: make "generalize the outbox to multiple topics and aggregate types"
an explicit, separately listed P4.2 deliverable. It is the load-bearing step for
the whole asynchronous-confirmation design.

Related, and worth stating in the plan's UI section: the outbox poller runs only
in the worker, single threaded, on a one-second loop draining one row per
transaction (`apps/worker/src/index.ts:99-138`). A confirmation event on that
queue inherits scan-analysis dispatch latency and head-of-line behavior, which is
exactly what determines how long the user waits on "Saving."

### G9. Ownership of `albums`, `releases`, and `catalog_references` is unstated

`confirmScan` writes catalog rows inside the confirmation transaction: the album
upsert at `packages/database/src/confirmation-repository.ts:170-218`,
`catalog_references` inserts at `:220-238` and `:306-324`, the release upsert at
`:240-304`, and a second advisory lock keyed on `(provider, releaseGroupId)` at
`:161-168`. The transaction spans six tables across three candidate service
boundaries.

The plan describes discovery as owning provider adapters, cache, and rate
coordination - all read side - and says library features stay in the core
application. That is probably the right answer for these three tables, but the
plan never says it, and discovery is the intuitively natural owner. Leaving it
implicit invites the wrong split later.

Suggestion: state in P4.1 that discovery is stateless - adapters, cache, and rate
lease only - and that canonical catalog tables stay with the library, so
`confirmScan` keeps one transaction across catalog and library writes. That also
makes P4.1 genuinely low risk, which is the right shape for a first extraction.

### G10. The restrict foreign key protecting the audit trail cannot survive the split cleanly

`scan_confirmations.library_item_id` is a deliberate `restrict` foreign key
(ADR-0011). Three behaviors depend on it today: `deleteLibraryItem` rejecting
with `invalid_state` when confirmation history exists, the collection and
wishlist pages hiding "Remove" accordingly (`docs/HANDOFF.md:331-338`), and
`DELETE /account`'s ordered delete (ADR-0014).

P4.2 puts scans and library in different service-owned schemas and prohibits
cross-service table access. Because the plan keeps one physical PostgreSQL
deployment initially, the cross-schema foreign key will keep working - which is
exactly the trap. It is easy to leave in place and then discover it blocks the
eventual physical split. The plan says to preserve historical audit links but
does not address the enforcement mechanism.

Suggestion: decide explicitly in P4.2 whether that foreign key is dropped and the
invariant re-implemented in the application, and record it. It also makes
`DELETE /account` a cross-service workflow, which the plan already anticipates;
this is the concrete reason why.

### G11. Terraform state transfer is one bullet and is the riskiest step in the plan

P4.3 compresses "transfer existing Terraform configuration and state ownership
without recreating resources or allowing two repositories to apply the same
state" into a single line. That is four transfers, not one - `bootstrap`,
`development`, `environment`, and `production` (`docs/OPERATIONS.md:10-21`). The
2026-09-07 incident (`docs/HANDOFF.md:56-91`) was an orphaned state lock plus an
emergency `skip_activation_check` bypass that issue #10 explicitly says should
not yet be trusted as a standing capability.

Suggestion: make the transfer its own step, with a rehearsal against the
`development` root first, an explicit single-writer and lock-ownership rule, and
issues #9 and #10 closed beforehand.

## Clarity of goals and outcomes

### What is already clear and should be kept

- The framing sentence and the closing line - that Phase 4 succeeds even if some
  benchmarks show the simpler architecture was already sufficient - make the
  thesis falsifiable. That is the plan's best feature.
- "Do not claim an architectural improvement before measuring it."
- P3.2 is the only milestone with a number: at least nine of ten deliberate cover
  presentations, on each target phone, in a documented test. It is the model the
  others should follow.
- P3.4's full-library search with pagination closes real drift. `docs/API.md:21`
  states cursor pagination as a convention, while `docs/ROADMAP.md:66-71` records
  that the library has none and searches within a 100-item fetch.

### Criteria that cannot be failed as written

| Criterion                                                   | Problem                        | Concrete replacement                                                                               |
| ----------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------- |
| P3.3 "complete each journey without scanning"               | Journeys unnamed, no actor     | List the journeys (search, favorite, playlist, add to wishlist), each as a browser test            |
| P3.4 "new users can complete... without coaching"           | No count, no task list, no bar | A stated number of participants, a fixed task list, and a recorded assist/failure count            |
| P3.5 "publish reproducible measurements"                    | Publishing is not a threshold  | A committed benchmark script plus a results file stating hardware and cache conditions             |
| P4.4 "report measured improvements, regressions..."         | Same shape                     | Add that the P3.5 benchmark runs unmodified against the extracted topology                         |
| "Equal emphasis on product usability and engineering depth" | Constraint with no test        | Express as a rule - every milestone ships one user-visible change and one measurement - or drop it |

Honest reporting as the P4.4 exit is right and should stay. It needs the
mechanical comparison bolted to it so before-and-after is enforced rather than
narrated.

### Sequencing

- P3.5's instrumentation is a P3.1 dependency, so P3.5 as written is misnumbered.
  Either move the instrumentation deliverable into P3.1's row - the preferable
  option, since the benchmark itself can stay last - or renumber.
- P3.3 is the largest new surface and is fully independent of capture. The plan
  never says what is cuttable if budget or time slips. Naming P3.3 as the cut
  line makes the plan more credible, not less.

### Measurement design: one confound worth naming

The plan proposes comparing one worker against several under the same workload
and total provider concurrency cap. `enforceScanQuota` takes
`pg_advisory_xact_lock(hashtext(userId))`
(`packages/database/src/scan-repository.ts:375-377`), and `createOrGetScan` takes
a `select ... for update` on the batch row (`scan-repository.ts:112-118`). A load
test driven by one synthetic user, or one batch, serializes on those locks and
measures the lock rather than the worker topology. Specify multiple synthetic
users and batches in the load profile.

### Documentation drift the plan should resolve explicitly

- `docs/ROADMAP.md:213-216` still defines Phase 3 as "UI/UX polish and AI model
  training/optimization," a placeholder. The plan redefines Phase 3 and defers
  training to a Phase 5 that does not exist in the roadmap. The plan should state
  that it supersedes the placeholder.
- `docs/ROADMAP.md:110` gates the formal private AI evaluation on public
  rollout, but the repository is already public. P4.5 is the right place to
  restate that gate in terms of public usage.
- The plan correctly identifies that ADR-0005 must be superseded. ADR-0001's
  statement that packages are the extraction seams, and
  `docs/ARCHITECTURE.md:58-65`'s instruction to split a service only when
  measurements justify it, both already endorse the Phase 4 approach and are
  worth citing in the new ADR as continuity rather than reversal.

## Not recommended for change

These parts of the plan were examined and deliberately left alone.

- The Phase 4 scan-extraction contract design: outbox, versioned event,
  idempotent consumption, completion projection, `Saving` UI state, and duplicate
  and key-conflict rules. It is careful and correct, and the existing outbox is a
  well-built precedent. Skip-locked claiming, backoff deferral, the pending
  partial index (`packages/database/src/schema.ts:202-204`), and the
  same-transaction producer pattern are all topic-agnostic already; only the four
  scan-specific constraints in G8 need removing.
- Avoiding dual writes, and the additive-migration, backfill, verify, and writer
  cutover sequence.
- One physical PostgreSQL deployment with per-service schemas and separate
  credentials, documented as a shared failure boundary.
- Keeping browser traffic behind the web application, and requiring authenticated
  service identity rather than a user-ID header.
- Treating $25 as a constraint requiring verification rather than an estimate.
- The deferral list: native apps, streaming, recommendations, unconstrained cover
  detection, dedicated search infrastructure, and model training.
- Beginning affected-workspace build optimization in Phase 3 so its gains are
  separable from service extraction. Worth noting that the repository has npm
  workspaces only, with no Turborepo or Nx, so the tool choice is itself an
  ADR-worthy decision that touches every CI job.
