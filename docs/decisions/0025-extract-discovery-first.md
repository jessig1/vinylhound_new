# ADR-0025: Extract discovery as the first service boundary

- Status: Accepted
- Date: 2026-09-18
- Builds on: [ADR-0009](0009-musicbrainz-primary-catalog.md),
  [ADR-0016](0016-tiered-aws-runtime-and-sqs.md),
  [ADR-0019](0019-spotify-discovery-provider.md)

## Context

Roadmap P4.1 Task 1 asks to record the reason to extract, the expected
benefit, the cost, and the rollback path for discovery — the first of Phase
4's measured service extractions — before Task 2 starts the actual
extraction work. Per `docs/ROADMAP.md`'s "Sequence and gates" note, this is a
proceed/defer decision, not the extraction itself: Task 2 (move the adapters
behind an authenticated API), Task 3 (confirm catalog ownership stays with
core), Task 4 (a separate ADR choosing the coordination substrate), and Task
5 (service image/ECR/IAM/staging delivery) remain their own gated steps and
are not decided here.

**The coordination gap is a standing commitment, not a new argument.**
[ADR-0009](0009-musicbrainz-primary-catalog.md#consequences) already states
that "catalog lookups need a shared limiter, cache, and asynchronous
execution when enrichment is attached to scans." That requirement has never
been met. `packages/catalog/src/musicbrainz-catalog.ts` holds two
per-process `Map` caches with a 24-hour TTL
(`musicbrainz-catalog.ts:135-143`) behind a single serialized limiter that
spaces MusicBrainz requests exactly one second apart
(`musicbrainz-catalog.ts:130-131`, `:437`), and
`packages/catalog/src/spotify-discovery.ts` holds the same shape — an
unbounded per-process `Map` cache with a one-hour TTL
(`spotify-discovery.ts:144-145`) and a per-process cached OAuth token
(`spotify-discovery.ts:238`) — for Spotify. Both guarantees hold only because
exactly one process constructs each provider today
(`apps/web/src/server/context.ts:43-54`). Scaling `apps/web` to more than one
replica — which P2.5's web scaling limits already allow — silently breaks
MusicBrainz's one-request-per-second promise and multiplies Spotify token
requests, with no test able to catch it because the limiter is closure-scoped
per process. This is a real, dated commitment coming due, not a
first-principles architecture preference.

**P3.5 gives no discovery-specific load evidence, and that itself is
informative.** P3.5's benchmark (`scripts/benchmark/`) and concurrency
comparison (`scripts/concurrency/`) both drive the scan pipeline, not
catalog or discovery reads, and `docs/OPERATIONS.md`'s live CloudWatch sample
(P3.5 Task 3, 111 real `http_request` events) recorded no `catalog.*` or
`discovery.*` route at all. There is no measured discovery latency or volume
to extract "toward" — the reconciled baseline
(`docs/OPERATIONS.md`'s "Reconciled monthly budget" section: $5.60/month
persistent baseline, $14.40/month of headroom before any staging/production
activation, staging activation ~$0.30-0.45 per lifecycle run) is what bounds
what this extraction may cost, not evidence that discovery itself is a
bottleneck. The case for extracting discovery first is structural readiness
and a pre-existing correctness gap, not measured pressure.

**The read path is the cheapest possible first cut.** `CatalogProvider` and
`DiscoveryProvider` are each a small port with few call sites
(`apps/web/src/app/api/v1/catalog/releases/route.ts`,
`apps/web/src/app/api/v1/discovery/*`), constructed in one place
(`context.ts:43-54`), with their error types already mapped to HTTP status at
the boundary (`apps/web/src/server/http.ts`). Neither provider writes to a
database; `packages/database` is untouched by either. That is a much smaller
surface than P4.2's scan/confirmation extraction, which spans six tables
across three candidate service boundaries (`confirmScan`'s catalog writes,
per `docs/PHASE_3_4_PLAN_REVIEW.md`'s G9) and needs the outbox generalized
first. Discovery is the low-risk extraction the roadmap's ordering ("run P4.1
before P4.2") calls for.

## Decision

**Proceed with discovery extraction, scoped narrowly.** The reason is
ADR-0009's unmet coordination requirement plus the structural readiness
above, not a measured load problem — P3.5 found none to point at.

**Discovery stays stateless in the sense that matters for ownership:**
provider adapters, cache, and rate/token coordination move; canonical
`albums`, `releases`, and `catalog_references` do not (Task 3 restates this
formally). `confirmScan` keeps one transaction across catalog and library
writes. This is what keeps the extraction low-risk — no cross-service dual
write is introduced by Task 1-3's scope.

**Expected benefit:**

- Closes ADR-0009's outstanding requirement: a real shared limiter and cache
  survive `apps/web` scaling to multiple replicas, which nothing in the
  current per-process design does.
- Isolates two outbound third-party dependencies (MusicBrainz, Spotify) so a
  provider outage, rate-limit response, or Spotify's known 403 Premium
  blocker (`docs/HANDOFF.md`, still open) degrades one small service rather
  than the whole `apps/web` process's request path.
- Gives Phase 4 a real, low-risk rehearsal of the extraction mechanics —
  service image, ECR, IAM, staging delivery, contract-versioned internal API
  — before attempting the materially harder P4.2 scan/confirmation split.

**Cost, named rather than estimated away:**

- A new ECR repository and image build (today's `bootstrap/main.tf` has
  exactly three: `web`, `worker`, `worker-lambda` — extraction adds a
  fourth), plus its own Pod Identity/IAM role and staging ECS service
  definition (P4.1 Task 5).
- Per `docs/PHASE_3_4_PLAN_REVIEW.md`'s G6, a service exists in three
  differently-shaped runtime tiers (development: Lambda, staging: ECS,
  production: EKS). This ADR adopts G6's suggested scope narrowing:
  **staging and production receive the extracted service; development keeps
  discovery in-process behind the same port**, preserving development's
  scale-to-zero cost profile and avoiding a fourth Lambda function for a
  service with no measured load to justify one yet.
- An authenticated internal API between web and discovery (Task 2) is new
  surface: service identity and user authorization, not a forwarded user-ID
  header, per the roadmap's explicit instruction.
- The coordination substrate itself (Task 4) is an open cost, not decided
  here: either a single discovery replica (cheap, but a documented
  availability tradeoff — the one-request-per-second guarantee still
  requires exactly one instance) or a PostgreSQL-backed cache/rate lease
  (more resilient, more schema). No ElastiCache: zero Redis/ElastiCache
  resources exist anywhere in `infra/terraform` today, and adding one is a
  real recurring budget line against the $25/month reconciled ceiling that
  this ADR does not authorize by default.

**Rollback path:** because development keeps the in-process implementation
behind the same `CatalogProvider`/`DiscoveryProvider` ports, rolling back a
staging or production discovery deployment is a redeploy of the previous
`apps/web` image wired to the in-process adapter, not a data migration —
discovery owns no canonical rows, so there is nothing to reconcile on the
way back. This is the same property P4.1's exit criterion asks Task 5 to
demonstrate directly: deploy and roll back a discovery-only change in
staging without rebuilding web or worker.

## Consequences

- P4.1 Task 2 onward may proceed. Task 4 still owes its own ADR for the
  coordination substrate; this ADR deliberately does not pre-decide it
  beyond ruling out ElastiCache-by-default.
- Development's runtime shape is unchanged by this extraction; only staging
  and production gain a new service, new ECR repository, and new IAM role.
- No canonical data ownership changes: `albums`, `releases`, and
  `catalog_references` stay with core/library under Task 3, so this
  extraction cannot become a second place that needs to agree with
  `confirmScan`'s transaction.
- Because P3.5 recorded no discovery-specific load or latency signal, P4.1's
  own exit criterion (deploy/rollback and coordination under concurrent
  callers) is the evidence this extraction will be judged on, not a
  before/after comparison against a P3.5 discovery baseline that does not
  exist.
- If a later session finds the single-replica coordination tradeoff
  unacceptable, or the four-manifest EKS cost outweighs discovery's real
  traffic once measured, that is a live decision for Task 4 and P4.4's final
  topology review — not a rollback of this ADR, whose scope is limited to
  proceeding with the extraction at all.
