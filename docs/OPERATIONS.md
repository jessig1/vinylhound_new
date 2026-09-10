# Operations runbook

## AWS topology

Run `apps/web` and `apps/worker` as separate stateless processes. Every cloud
environment has its own PostgreSQL database, SQS FIFO queue and dead-letter
queue, private versioned S3 bucket, secrets, DNS name, and Terraform state.
Never deploy local Compose credentials to a public environment.

The four Terraform roots have distinct ownership:

- `bootstrap` creates the encrypted/versioned state bucket, immutable web,
  worker, and Lambda-worker ECR repositories, and environment-scoped GitHub
  OIDC roles;
- `development` creates the always-live API Gateway/Next.js Lambda, SQS-driven
  analysis Lambda, EventBridge outbox publisher, S3, secrets, and DNS, while
  the PostgreSQL-compatible serverless database is managed externally;
- `environment` is staging-only and creates the just-in-time ALB/ECS/Aurora/S3/
  SQS stack; and
- `production` retains Aurora/S3/SQS/secrets and creates EKS, NAT, an internal
  ALB, CloudFront VPC origin, WAF, and Kubernetes workloads only while active.

Apply bootstrap once with an AWS administrator identity. All environment work
then uses GitHub OIDC. Lambda roles, ECS task roles, and EKS Pod Identity roles
provide short-lived AWS credentials; the web role cannot read the OpenAI key.
Aurora uses `DATABASE_SSL_MODE=verify-full` with the regional RDS CA bundle.
Keep database pools bounded (two connections per Lambda environment and five
per ECS task or pod). The external development `DATABASE_URL` must require TLS.

## Resource tagging

Every root's `provider "aws"` block sets `default_tags`, which the AWS
provider applies automatically to every resource type that supports tags —
new resources should rely on this rather than setting tags individually.
`development`, `environment`, and `production` each define a `local.common_tags`
map (`main.tf`/`locals.tf`/`foundation.tf`) with:

- `Application = "vinylhound"` — identifies every resource as belonging to
  this project, distinct from anything else in the account.
- `Environment` — `development`, `staging`, or `production`. The primary key
  for separating cost and blast radius between environments that otherwise
  share the same account and resource-naming scheme.
- `ManagedBy = "terraform"` — marks the resource as Terraform-owned, so it is
  never hand-edited or deleted from the console without updating state first.
- `Owner = "jessig1"` — the accountable person for cost and incident response.
- `ExpiresAt` (staging/production only) — the just-in-time activation's
  intended teardown time, or `"inactive"`/`"staging-pipeline"` when not
  counting down; lets the hourly deactivation sweep and any cost audit
  distinguish a fresh activation from one that has overrun.
- `CostProfile` — `scale-to-zero` (development) or `performance` (production);
  a coarse cost/performance tradeoff label for budget review, independent of
  the numeric budget alarms already in place per environment.

Why this matters in practice, beyond convention:

- **Cost management.** AWS Cost Explorer can only break down spend by tag
  once a tag key is activated for cost allocation
  (Billing → Cost allocation tags); `Environment` and `Application` are the
  two keys that make a monthly cost review possible at all, since this
  account runs multiple environments and, over time, other projects side by
  side.
- **Finding resources.** Tag-based lookups (the Resource Groups & Tag Editor
  console, or `aws resourcegroupstaggingapi get-resources`) are the only
  reliable way to find every resource belonging to one environment when a
  Terraform apply has failed partway and console inspection is the fastest
  way to confirm real state — as happened during the first production
  rehearsal, where confirming live resources required checking the console
  directly because Terraform's own state had drifted from reality.
- **Automation.** The hourly `deactivate-environment.yml` sweep and any
  future cost- or compliance-driven automation (e.g. "alert on anything
  tagged `production` older than its `ExpiresAt`") depend on tags being
  present and accurate, not on naming conventions alone, since naming drifts
  more easily than a value the provider stamps on every apply.

Known gaps, tracked as a Phase 2 follow-up issue: `bootstrap`'s tags
(`infra/terraform/bootstrap/versions.tf`) are a separate literal map missing
`Environment`/`Owner`/`ExpiresAt` rather than reusing the `common_tags`
pattern (arguably correct, since bootstrap resources are account-level and
outlive any one environment, but not yet a deliberate decision written down
anywhere); and no audit has yet confirmed every resource across all four
roots actually receives `default_tags` — a small number of AWS resource types
do not support tags at all, and it is not yet verified which of this
project's resources fall into that category.

## Just-in-time lifecycle

Development is always reachable but scales compute to zero. Staging and
production use `environment_active=false` as their resting state. Staging
retains its VPC, S3, zero-ACU Aurora, SQS, secrets, certificate, logs, and state.
Production retains the same data plane and control metadata while removing
NAT, EKS/control-plane compute, nodes, ALB, CloudFront distribution, WAF, and
application DNS.

- Every merge to `main` updates development, then builds digest-addressed ARM64
  web and worker images, activates staging without services, migrates, deploys,
  smoke-tests, marks the digests staging-verified, and deactivates staging.
- Production is a manual GitHub deployment of a full commit SHA that has
  staging-verified ECR tags. Its TTL is one, two, four, or eight hours. The
  workflow runs migrations as a Kubernetes Job before applying Deployments.
- An hourly workflow reads the SSM activation/expiry markers and deactivates an
  expired production runtime.
- Both deploy workflows run `scripts/aws/ensure-database-available.sh` right
  after creating the persistent foundation, before anything tries to connect.
  It distinguishes Aurora Serverless v2's normal 0-ACU auto-pause (stays
  `available`, resumes in seconds on the next connection — no action needed)
  from an explicit administrative `stopped` cluster (a distinct AWS state
  that ignores connection attempts entirely and only leaves via
  `start-db-cluster`, which this script issues before polling for
  `available`, up to 20 minutes). A full stop can happen outside this
  repository's own automation — e.g. a manual cost-saving action — so this
  exists to make deploys self-heal from that state rather than fail at the
  migration step with a bare connection-timeout error.
- Before production deactivation, delete the web HPA, scale web to zero, and
  run `npm run ops:drain-check` through the worker deployment until PostgreSQL
  and SQS are drained. Manual forced teardown is allowed only as an explicit
  recovery choice; SQS and PostgreSQL remain for later redelivery/reconciliation.
- `npm run ops:reconcile-queue` republishes database-authoritative queued jobs.
  SQS and scan processing are idempotent, so a duplicate is safe.

Terraform protects Aurora and the image bucket from destruction. Account
decommissioning requires an explicit code review that removes `prevent_destroy`;
normal JIT workflows never do this.

## Deployment and rollback

Staging first provisions task definitions with ECS services disabled, runs a
one-off Fargate migration, and creates services only after success. Production
first provisions EKS/edge resources, creates secret-backed Kubernetes runtime
configuration, runs a migration Job, and applies workloads only after success.
Migrations use the application's bounded, CA-verified database configuration;
they are forward-only and must remain compatible with the previous image. An
operator rollback redeploys previous ECR digests and never reverses a migration.

Before the first deployment, populate the database URL (development only),
Clerk secret, Clerk publishable key, and OpenAI key containers named by each
root's outputs. Never put those values in Terraform variables or GitHub secrets.

## Backup and restoration

Managed PostgreSQL must retain daily backups and point-in-time recovery for at
least 30 days. Object storage versioning protects against accidental object
deletion; its retention must be at least the database recovery period. Test a
restore monthly and after a database-provider change:

1. Restore a production backup to an isolated database and use separate,
   non-production storage credentials.
2. Apply `npm run db:migrate`, start one web instance and one worker against
   the restored database, and verify an account export and a representative
   scan audit trail (without sending a provider request).
3. Record the backup timestamp, restore duration, result, and operator in the
   incident log; investigate any mismatch before relying on the backup.

For local and CI smoke verification, `npm run ops:restore-test` makes a logical
dump of the Compose PostgreSQL database, restores it to the isolated
`vinylhound_restore_verification` database, checks the migration table, then
removes that temporary database and dump. It never targets the application
database for deletion.

## Monitoring and alerts

Load balancers should probe `GET /api/healthz`; orchestration readiness checks
should probe `GET /api/readyz`, which verifies PostgreSQL without exposing
connection details. Both return `Cache-Control: no-store` and are public so an
external monitor can reach them in production auth mode.

Collect JSON-capable application logs from web and worker processes. Retain the
stable request, scan, outbox message, job, and attempt IDs already emitted by
the application, but never signed URLs, credentials, or image bytes. Every
`apps/web` API route logs one `[web] http_request` line (route, method,
status, `durationMs`, `requestId`, and `correlationId` if the caller sent one)
via a shared `withRoute` wrapper (`apps/web/src/server/http.ts`), so this is
no longer only true of the durable IDs — an inbound `x-request-id` header is
validated (bounded length/charset, dropped rather than rejected if malformed)
and forwarded as `correlationId` onto the outbox row, the job payload, and the
`scan_attempts` row the worker writes, so one caller-supplied trace value can
be grepped across the HTTP request, the queued job, and the analysis attempt.
It is untrusted metadata only: never used for lookups, joins, or
authorization. The upload-complete route additionally logs
`[web] upload_complete_timing` with `uploadPhaseDurationMs` (readback plus
validation) and `normalizationPhaseDurationMs` (deriving and storing the
analysis/thumbnail variants) separated; the worker logs
`[worker] scan_analysis_timing` with `storageFetchDurationMs` and
`providerCallDurationMs` split out from the existing bundled
`scan_attempts.duration_ms`. Alert on:

- readiness failures or sustained 5xx responses;
- queue age above five minutes, outbox publish failures, and worker restarts;
- analysis failure/rate-limit spikes and p95 attempt duration regressions;
- daily provider spend reaching 70%, 90%, and 100% of the OpenAI project cap;
- unexpected 429 `quota_exceeded` volume (a possible abuse signal).

## Abuse and spend controls

The web process enforces these limits transactionally before each initial
submission or retry is written to the outbox: `USER_DAILY_ANALYSIS_LIMIT`,
`USER_ACTIVE_SCAN_LIMIT`, and `USER_MONTHLY_SPEND_LIMIT_USD`. Pending scans
reserve `SCAN_COST_RESERVATION_USD` each, so a burst cannot spend past the
monthly limit while token usage is still unknown. This check is the single
authoritative gate: it takes a per-user `pg_advisory_xact_lock` first, so
concurrent tabs or batch submissions see a consistent reservation balance
before either can enqueue. The defaults are for local development; production
must deliberately set values aligned with the OpenAI project's hard monthly
limit. The OpenAI project must additionally have its own spend cap and rate
limits, because application controls are defense in depth.

`GET /quota` (P3.1) reports the same three signals as an advisory, unlocked
read — `{ used, limit, remaining }` per dimension plus `admissible` — so the
`/scan` capture session can decide whether to start expensive upload/
normalization work before spending it, without paying the lock's
serialization cost on every page load. `POST /scans` runs the same unlocked
check before creating a genuinely new scan, rejecting early when it is
already clearly inadmissible. Both are best-effort: they can be stale under
concurrency in either direction, and the transactional check above remains
the only thing that can actually block a submission.

**Reconciling the defaults.** `USER_ACTIVE_SCAN_LIMIT` (20) intentionally
equals `MAX_SCANS_PER_BATCH` (20): a full capture session should be able to
have every one of its records in flight at once without a second,
independent ceiling cutting it off first. `USER_DAILY_ANALYSIS_LIMIT` (100)
is set well above the active-scan limit so a day of normal retries and
several sessions do not routinely collide with it; `ANALYSIS_CONCURRENCY`
(1) governs how many analysis jobs one worker process runs at a time, not
how many a user may have queued, so it is independent of the per-user limits
by design and is scaled by adding worker capacity, not by relaxing quota.

**Queue-pressure pause/resume.** When the active-scan or daily/spend limit is
already exhausted, `/scan` shows why (via `GET /quota`'s `blockedBy`) and
disables starting or resuming a session rather than letting requests fail
into an opaque error. If a record's submit is rejected mid-session anyway
(the advisory check raced a concurrent submission), the session does not
retry it automatically — it surfaces the failure, refreshes the quota
banner, and waits for the user to retry once headroom returns, polled every
20 seconds while blocked. This applies uniformly to all three quota
dimensions; there is no separate faster path for an active-scan limit that
is expected to clear soon versus a daily/spend limit that will not clear
until its window resets; the difference shows up only in the banner's
message, not in retry behavior.

**Batch rollover.** A single batch's `MAX_SCANS_PER_BATCH` (20) ceiling does
not change and is not a per-session limit: a continuous capture session may
span more than one batch so a user is never hard-stopped at 20 records.
Defined behavior, for P3.2's continuous-capture state machine to implement
(today's one-shot `/scan` picker already refuses to queue more than
`MAX_SCANS_PER_BATCH` records client-side, so it cannot reach this path and
none of this is implemented yet):

- The session, not the batch, is the client-side unit of continuity. The
  client tracks an ordered list of batch IDs for one session instead of a
  single `batchId`; `createOrGetScan` already rejects a new scan against a
  full batch with a distinct `batch_scan_limit` error
  (`packages/database/src/scan-repository.ts:154-158`), which is the signal
  a rolled-over client reacts to (proactively tracking its own per-batch
  count to roll over before hitting the limit is also valid — either way,
  the server's rejection is authoritative and must never be silently
  retried against the same batch).
- On rollover, the client calls `POST /batches` for a new batch and directs
  every subsequent record's `POST /scans` at the new batch ID. No schema,
  contract, or server change is required: this composes the existing
  `POST /batches` + `POST /scans` primitives, which already treat a batch as
  an unordered collection of independently tracked scans (ADR-0006). No
  batch-of-batches or session-level persisted entity is introduced.
- Review-later navigation and the persisted `localStorage` queue key on the
  session's batch list, not one ID: the "review them now" link points at the
  most recent still-open batch, with earlier rolled-over batches from the
  same session listed alongside it rather than replaced.
- Quota headroom is unaffected by rollover: `USER_ACTIVE_SCAN_LIMIT` and
  `USER_DAILY_ANALYSIS_LIMIT` count a user's scans regardless of which batch
  they belong to, so a session that rolls over into a second, third, or later
  batch is still governed by the same active-scan/daily/spend ceilings
  described above. If headroom is exhausted exactly at a rollover boundary,
  the existing queue-pressure pause/resume behavior applies unchanged — the
  session pauses and waits for headroom, then creates the new batch once
  resumed rather than treating rollover as a separate failure mode.

## Abandoned uploads

A scan left `awaiting_upload` — created, possibly with images attached, but
never submitted — does not count against any of the quota dimensions above,
but it does hold one of a batch's 20 scan slots and can leave uploaded image
objects in storage indefinitely (a closed tab, a crashed browser, a
recapture that never got its new photo reattached). The worker polls for
these independently of the outbox (`ABANDONED_UPLOAD_CLEANUP_INTERVAL_MS`,
default 30 minutes) and cancels any `awaiting_upload` scan with no activity —
neither the scan nor any of its images was created — within the last
`ABANDONED_UPLOAD_TTL_HOURS` (default 24). A scan a user is still actively
adding photos to is left alone even if it was originally created long
before the TTL, since the check looks at the most recent image, not only the
scan's own creation time. Canceling frees the batch slot the same way an
explicit cancel does; each of the scan's images' `original`/`analysis`/
`thumbnail` objects is then deleted from storage best-effort (logged, not
retried, mirroring `DELETE /account`'s cleanup) rather than left orphaned.

## AWS telemetry and budget

SQS supplies queue depth, age, in-flight, and dead-letter metrics without a
custom polling namespace. Staging scales workers from one to five ECS tasks on
visible queue depth and web from one to three on CPU. Production uses
Kubernetes HPAs for web and worker pods and CloudWatch alarms for SQS age/DLQ;
EKS control-plane logs retain API, audit, and authenticator events. Lambda and
staging logs retain seven days; production logs retain thirty days.

Development has a $10 monthly budget notification, staging $20
(`infra/terraform/environment/monitoring.tf:125-128`, previously undocumented
here), and production $25 — all three at 40%, 60%, 80%, and 100% thresholds.
Deployment checks account month-to-date AWS spend and refuses normal
production activation at $20. A production operator can use the explicit
break-glass input only after reviewing active resources and the requested
TTL. Budget data is delayed and is not a hard cap; the hourly TTL teardown
remains the primary cost control.

## Persistent spend inventory (pre-P3.5)

P3.1 Task 7 inventories what is billed today, independent of whether staging
or production is active, before P3.2 onward adds any billable resource. This
is a known-costs-and-unknowns list, not a reconciled budget; P3.5 Task 1
produces the actual reconciliation (development, both Aurora data planes,
storage/backups/logging, capped AI usage, and declared staging/production
activation hours against the $25 total).

**Always billed, regardless of environment activation:**

- **Development runtime** — always-live API Gateway + Next.js Lambda,
  SQS-driven analysis Lambda, and EventBridge outbox publisher
  (`infra/terraform/development/main.tf`); pay-per-request, near-zero at
  current traffic but uncapped by design (no TTL teardown applies to
  development).
- **Aurora Serverless v2 storage** in both staging and production
  (`infra/terraform/environment/database.tf:29-31`,
  `infra/terraform/production/foundation.tf:177-179`) — `min_capacity = 0`
  means compute suspends to near-zero when inactive, but allocated storage is
  billed continuously in both environments even while `environment_active =
false`.
- **S3 image buckets** in all three environments, versioned with a
  noncurrent-version expiry (14 days in development, per
  `infra/terraform/development/main.tf:51-65`; 35 days in both staging,
  `infra/terraform/environment/storage.tf:52-60`, and production,
  `infra/terraform/production/foundation.tf:139-146`). Storage cost grows
  with usage and is never torn down by the TTL sweep.
- **Secrets Manager** — one secret in development
  (`infra/terraform/development/main.tf:107`), four each in staging (database
  URL in `infra/terraform/environment/database.tf:53`; Clerk/OpenAI keys in
  `infra/terraform/environment/storage.tf:69-79`) and production
  (`infra/terraform/production/foundation.tf:194-210`) — nine secrets total,
  each with Secrets Manager's flat per-secret monthly fee regardless of
  activation state.
- **CloudWatch Logs** — retained continuously per environment (development 7
  days, `infra/terraform/development/main.tf:183`; staging 7 days/production
  30 days, `infra/terraform/environment/ecs.tf:25`; production EKS
  control-plane logs 30 days, `infra/terraform/production/eks.tf:21,26`).
  P3.1 Task 6's new per-request structured logging (`[web] http_request`,
  `[web] upload_complete_timing`, `[worker] scan_analysis_timing`) adds log
  volume on top of this baseline; the volume increase has not been measured.
- **VPC/subnet foundation and Route 53 DNS** in staging and production persist
  by design (ADR-0016) independent of `environment_active`.

**Confirmed NOT persistent** (conditional on `environment_active`, verified
in Terraform): NAT gateway
(`infra/terraform/environment/network.tf:49-68`,
`infra/terraform/production/foundation.tf:66-81`), ECS tasks/ALB (staging),
and EKS/internal ALB/CloudFront VPC origin/WAF (production) — all `count =
local.active_count`, so the hourly TTL sweep actually removes their cost, not
just their availability.

**Unknowns to carry into P3.5's reconciled budget artifact:**

- Where the development database is actually hosted and billed — it is
  external to these Terraform roots ("managed externally," this file's AWS
  topology section) and its cost is outside this inventory entirely.
- Actual Aurora storage cost at current data volume, in both staging and
  production, has not been measured against a real AWS Cost Explorer report.
- Actual S3 storage cost at current object counts/sizes across all three
  buckets has not been measured.
- How many staging and production activation-hours per month P3.2 onward will
  actually need; today's usage is ad hoc rehearsal, not a steady cadence.
- The added CloudWatch Logs ingestion/storage cost from Task 6's new
  structured logging lines.
- Actual aggregate OpenAI spend against the $20 `USER_MONTHLY_SPEND_LIMIT_USD`
  per-user default, which alone is 80% of the $25 total monthly target
  (`docs/PHASE_3_4_PLAN_REVIEW.md:60-66` already flags this tension) — no
  multi-user usage data exists yet to reconcile it against actual traffic.
