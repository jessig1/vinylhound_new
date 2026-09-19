# ADR-0026: Discovery keeps a single replica; the coordination substrate stays in-process

- Status: Accepted
- Date: 2026-09-18
- Builds on: [ADR-0025](0025-extract-discovery-first.md),
  [ADR-0009](0009-musicbrainz-primary-catalog.md),
  [ADR-0016](0016-tiered-aws-runtime-and-sqs.md)

## Context

Roadmap P4.1 Task 4 asks to decide, in its own ADR, how `apps/discovery`
coordinates its provider caches and rate limiter once more than one process
could run it: a PostgreSQL-backed cache/rate lease shared by replicas, or a
single discovery replica with explicit availability and rollout constraints
preventing overlapping independent limiters. ADR-0025 deliberately left this
open, ruling out only ElastiCache-by-default; ADR-0025's own text frames the
choice as "a single discovery replica (cheap, but a documented availability
tradeoff...) or a PostgreSQL-backed cache/rate lease (more resilient, more
schema)."

**What `apps/discovery` coordinates today, unchanged since Task 2.**
`packages/catalog/src/musicbrainz-catalog.ts` holds two per-process `Map`
caches with a 24-hour TTL and a serialized limiter spacing requests exactly
one second apart; `packages/catalog/src/spotify-discovery.ts` holds an
unbounded per-process `Map` cache with a one-hour TTL and a cached OAuth
token. Neither has a size bound or eviction beyond TTL expiry — "bounded
cache" in the roadmap's Task 2 wording refers to time-bounded (TTL), not
count-bounded; there is no `maxEntries`/LRU anywhere in either file. Both
guarantees (the MusicBrainz rate ceiling, a coherent cache) hold only within
one process, which is exactly the gap ADR-0009 named and ADR-0025 extracted
discovery to close — but Task 2 only moved that same single-process shape
into `apps/discovery`. It did not make the shape correct under more than one
replica; that is this ADR's job.

**No measured signal exists to size this decision against.** ADR-0025 already
established that P3.5's benchmark, concurrency comparison, and live
CloudWatch sample recorded zero `catalog.*`/`discovery.*` traffic. Nothing
has changed that since: `apps/discovery` does not yet run anywhere outside a
developer's own `npm run dev:discovery` (Task 5 has not started). This
decision is therefore about the cheapest correct choice today, with an
explicit, named trigger for revisiting it — not a capacity decision made
against real load.

**Every other production workload in this repository already scales past one
replica, which makes "single replica" a real, visible exception, not a
default.** `infra/kubernetes/production/web.yaml` runs `replicas: 2` with an
HPA (`minReplicas: 2`, `maxReplicas: 6`) and a `PodDisruptionBudget`
(`minAvailable: 1`); `infra/kubernetes/production/worker.yaml` runs
`replicas: 1` with an HPA up to 5. Staging's `infra/terraform/environment/
ecs.tf` autoscales `web` to 3 and `worker` to 5 (`aws_appautoscaling_target`,
target-tracking policies). ADR-0025 itself cites this: "Scaling `apps/web` to
more than one replica — which P2.5's web scaling limits already allow —
silently breaks MusicBrainz's one-request-per-second promise." A
single-replica discovery service is a deliberate, permanent departure from
that pattern for as long as this decision stands, not a temporary default
nobody will notice.

**A rolling deploy overlaps two processes even at a fixed replica count of
one, in both target runtimes.** Neither `aws_ecs_service.web`/`worker` in
`infra/terraform/environment/ecs.tf` nor `infra/kubernetes/production/
worker.yaml` sets a non-default deployment strategy: ECS defaults to
`deployment_minimum_healthy_percent = 100` / `maximum_percent = 200` (starts
the new task before stopping the old one), and Kubernetes' default
`RollingUpdate` strategy does the same (`maxSurge` rounds up to at least one
extra pod even at `replicas: 1`). A discovery service deployed the same way
would briefly run two processes, each with its own independent one-second
MusicBrainz limiter and its own cache — momentarily doubling the real
request rate and serving from two incoherent caches during every deploy.
This is exactly the failure the roadmap names by asking for "explicit...
rollout constraints preventing overlapping independent limiters," not a
hypothetical: it is what the default deployment behavior of both target
runtimes would do if Task 5 wired discovery up the same way as web/worker.

## Decision

**Keep discovery's coordination in-process, pinned to exactly one replica
per environment (staging and production — development keeps the in-process
adapter under ADR-0025's tier scope and is unaffected), with an explicit
non-overlapping rollout strategy. Do not add a PostgreSQL-backed cache/rate
lease now.**

Reasons, in order of weight:

1. **A database-backed lease is a bigger reversal than it looks.** It would
   give `apps/discovery` a database connection, a credential, and a
   migration-owned schema — undoing the exact property Task 2 built and
   Task 3 just verified structurally: `apps/discovery/package.json` depends
   on `@vinylhound/catalog`, `@vinylhound/config`, `@vinylhound/contracts`,
   and `@vinylhound/service-auth` only, with no `@vinylhound/database`
   dependency, so it cannot reach a canonical row even by mistake. A
   disposable cache table in its own schema would not touch `albums`/
   `releases`/`catalog_references`, but it would still require wiring a new
   Aurora credential and connection pool into a service whose entire current
   failure surface is "call MusicBrainz/Spotify, sign a token" — and couple
   discovery's readiness to Aurora Serverless v2's cold start
   (`MinCapacity: 0` when paused, confirmed live in `docs/OPERATIONS.md`'s
   budget reconciliation) for a cache that exists only to avoid re-fetching
   data discovery could simply re-fetch.
2. **The single-replica cost is real but bounded, and the boundary is where
   ADR-0025 already drew it.** ADR-0025 isolated MusicBrainz/Spotify so "a
   provider outage... degrades one small service rather than the whole
   `apps/web` process's request path"; the same reasoning bounds this
   decision's downside. A brief gap during a discovery deploy or pod
   eviction produces a transient 5xx on catalog/discovery-only routes
   (`/api/v1/catalog/*`, `/api/v1/discovery/*`) through the existing
   `CatalogProviderError`/`DiscoveryProviderError` mapping at
   `apps/web/src/server/http.ts` — the core scan, confirm, and library flow
   is untouched, because `confirmScan`/`placeLibraryRelease` never call a
   live provider inside their transaction (Task 3). This is the explicit
   availability constraint the roadmap asks this ADR to state: discovery
   accepts a deploy-window and pod-eviction outage on discovery-only
   endpoints, scoped to a single pod's restart time, in exchange for a
   correct one-second MusicBrainz ceiling and a coherent cache without new
   infrastructure.
3. **This repository's own precedent for "needs coordination across
   processes" is a PostgreSQL lease taken with `FOR UPDATE SKIP LOCKED` or an
   advisory lock — but that precedent is currently used for exactly the kind
   of state that must be correct under concurrency and cannot simply be
   avoided** (`packages/database/src/scan-repository.ts`'s outbox claiming;
   `release-resolution.ts`'s `pg_advisory_xact_lock` around album identity).
   Discovery's rate limiter and cache are the opposite kind of state: the
   correctness requirement (do not exceed MusicBrainz's rate; do not serve
   two incoherent cache reads) is fully satisfiable by never running two
   discovery processes with live traffic at once, which a fixed replica
   count of one plus a non-overlapping rollout already guarantees without
   touching PostgreSQL at all. Reaching for the database precedent here
   would apply a tool built for "two processes really must both act
   concurrently and safely" to a problem that is actually "make sure only
   one process acts, ever" — a simpler property, cheaper to guarantee by
   topology than by coordination.
4. **No measured signal justifies the added surface yet**, per ADR-0025's own
   framing (P3.5 recorded zero discovery traffic) — matching this
   repository's evidence-first posture (P3.5 throughout; ADR-0025's own
   "proceed... is structural readiness... not measured pressure").

**Required rollout constraint (binding on Task 5's implementation, not
performed by this ADR):** discovery must deploy with a strategy that fully
stops the running instance before starting its replacement, not the
default overlap-tolerant rolling update — ECS
`deployment_minimum_healthy_percent = 0` (paired with
`maximum_percent = 100` so at most one task ever runs), or Kubernetes
`strategy: { type: Recreate }` — plus `desired_count`/`replicas` fixed at
exactly `1` with no autoscaling target (no `aws_appautoscaling_target`, no
`HorizontalPodAutoscaler`) and no `PodDisruptionBudget` (there is only one
pod to disrupt). This is a real, deliberate difference from how `web` and
`worker` already deploy in both tiers, and Task 5 should say so explicitly
in its own commit/roadmap note rather than silently copying the web/worker
pattern.

**Revisit trigger, stated so a future session does not have to re-derive
it:** reopen this decision once either (a) P4.1's own exit criterion —
demonstrating bounded cache and provider-wide rate coordination under
concurrent callers — surfaces evidence that a single Fargate task or pod
cannot keep up with real discovery traffic once `apps/discovery` actually
runs somewhere (Task 5) and is measured, or (b) the accepted deploy-window
outage becomes a real user complaint rather than a documented tradeoff. At
that point, a PostgreSQL-backed lease in discovery's own schema is the
documented upgrade path this ADR defers, not ElastiCache (still ruled out by
ADR-0025's budget reasoning: no Redis/ElastiCache resource exists in
`infra/terraform` today, and the $14.40/month pre-activation headroom in
`docs/OPERATIONS.md`'s reconciled budget has little room for a new always-on
resource).

## Consequences

- Task 5 must pin discovery to exactly one replica with a non-overlapping
  rollout strategy in both staging and production, as specified above — this
  is now a requirement on that task's implementation, not a detail left to
  its own judgment.
- Discovery is a single point of failure for catalog/discovery-only routes in
  both staging and production for as long as this ADR stands; core scan,
  confirmation, and library flows are unaffected (Task 3). No SLA beyond
  "brief outage during a deploy or pod eviction, self-healing on restart" is
  promised.
- `apps/discovery` remains database-free: no new Aurora credential, IAM
  role, or migration-owned schema is added by this decision. Its dependency
  surface stays exactly what Task 2/3 verified.
- The unbounded (count-wise) in-process caches in `musicbrainz-catalog.ts`/
  `spotify-discovery.ts` are unchanged by this decision and are noted as a
  separate, smaller known gap (`docs/HANDOFF.md`'s "Known gaps and risks") —
  relevant to a single long-lived production replica's memory growth over
  time, but not something this ADR's coordination-substrate choice needed to
  fix, since TTL expiry already bounds staleness even without a count bound.
- If a later session finds the single-replica availability tradeoff
  unacceptable before real load evidence exists, that is a live decision to
  reopen here, not a signal that ADR-0025's extraction itself was wrong.
