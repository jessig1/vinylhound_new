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

- Every merge to `main` updates development automatically
  (`deploy-development.yml`, still push-triggered).
- Staging and production are both manual `workflow_dispatch` jobs, not
  triggered by a push to `main`. Run `deploy-staging.yml` deliberately for a
  commit to build digest-addressed ARM64 web/worker images, activate staging
  without services, migrate, deploy, smoke-test, mark the digests
  staging-verified, and deactivate staging.
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
Implemented by P3.2's continuous-capture state machine. The original
one-shot picker limit was removed so this path is reachable:

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
is a known-costs-and-unknowns list, not a reconciled budget — the actual
reconciliation (development, both Aurora data planes, storage/backups/
logging, capped AI usage, and declared staging/production activation hours
against the $25 total) is in "Reconciled monthly budget (P3.5 Task 1)" below.

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
- **Secrets Manager** — four secrets in development
  (`infra/terraform/development/main.tf:107-115`, one `for_each` resource
  over `database-url`/`clerk-secret-key`/`clerk-publishable-key`/
  `openai-api-key` — a single Terraform resource block, but four real
  secrets; a previous version of this line undercounted it as one), four
  each in staging (database URL in
  `infra/terraform/environment/database.tf:53`; Clerk/OpenAI keys in
  `infra/terraform/environment/storage.tf:69-79`) and production
  (`infra/terraform/production/foundation.tf:194-210`) — **twelve secrets
  total, confirmed live via `aws secretsmanager list-secrets` on
  2026-09-17**, each with Secrets Manager's flat $0.40/secret monthly fee
  regardless of activation state ($4.80/month total, the single largest line
  in the persistent baseline — see "Reconciled monthly budget" below).
- **CloudWatch Logs** — retained continuously per environment (development 7
  days, `infra/terraform/development/main.tf:183`; staging 7 days/production
  30 days, `infra/terraform/environment/ecs.tf:25`; production EKS
  control-plane logs 30 days, `infra/terraform/production/eks.tf:21,26`).
  P3.1 Task 6's new per-request structured logging (`[web] http_request`,
  `[web] upload_complete_timing`, `[worker] scan_analysis_timing`) adds log
  volume on top of this baseline; the volume increase has not been measured.
- **ECR image storage** — three repositories (`vinylhound-web`,
  `vinylhound-worker`, `vinylhound-worker-lambda`, bootstrapped in
  `infra/terraform/bootstrap`), each digest-pinned and shared across all
  three environments. Missing from the original version of this inventory.
  Each repository carries a lifecycle policy retaining the newest 20 images
  and expiring the rest (`aws ecr get-lifecycle-policy`, confirmed live —
  not present in the Terraform source, so it was applied out of band and is
  worth moving into Terraform if it is ever lost), so storage is bounded
  rather than growing without limit as CI keeps publishing images.
- **VPC/subnet foundation and Route 53 DNS records** in staging and
  production persist by design (ADR-0016) independent of `environment_active`
  — but see the callout below: the hosted **zone** itself is not a
  VinylHound cost.

**Confirmed NOT persistent** (conditional on `environment_active`, verified
in Terraform): NAT gateway
(`infra/terraform/environment/network.tf:49-68`,
`infra/terraform/production/foundation.tf:66-81`), ECS tasks/ALB (staging),
and EKS/internal ALB/CloudFront VPC origin/WAF (production) — all `count =
local.active_count`, so the hourly TTL sweep actually removes their cost, not
just their availability.

**Confirmed NOT a VinylHound cost, found while reconciling actual AWS Cost
Explorer data (2026-09-17):** this AWS account also carries resources
unrelated to this project. `infra/terraform/environment/dns.tf:1` and
`infra/terraform/production/foundation.tf:3` both read the hosted zone as a
`data "aws_route53_zone"` — an existing zone the project adds records to, not
one it creates or pays for — and `aws route53 list-hosted-zones` shows
exactly one zone in the account, `siliconforest.io`, pre-dating and
independent of VinylHound. Its ~$71/year registrar fee and ~$0.50/month
hosted-zone fee are the account owner's regardless of whether VinylHound
exists, so they are excluded from the reconciliation below (VinylHound would
only add cost here if it registered its own domain or hosted zone, which it
does not). Cost Explorer also showed a recurring ~$3.72/month `Amazon
Lightsail` charge with no reference anywhere in `infra/terraform/`, and
`aws lightsail get-instances`/`get-static-ips`/`get-distributions`/
`get-domains` all returned empty on 2026-09-17 — an apparently-orphaned or
unrelated resource. Flagged for the maintainer to confirm and cancel if
abandoned; also excluded from the reconciliation below either way, since
nothing in this repository provisions it.

## Reconciled monthly budget (P3.5 Task 1, 2026-09-17)

Method: real AWS Cost Explorer pulls (`aws ce get-cost-and-usage`, monthly and
daily granularity, grouped by service, July–September 2026) cross-checked
against live resource state (`aws rds describe-db-clusters`, `aws ecs
list-clusters`/`list-services`, `aws eks list-clusters`, `aws s3 ls
--summarize`, `aws secretsmanager list-secrets`, `aws ecr describe-images`,
`aws logs describe-log-groups`) on a freshly reauthenticated session — the
AWS CLI session had expired at session start and the maintainer reauthenticated
live so this reconciliation could use real figures rather than list-price
estimates. Confirmed live on 2026-09-17: both `vinylhound-staging` and
`vinylhound-production` Aurora clusters are `available` with `AllocatedStorage:
1` (GB) and `MinCapacity: 0` (paused compute); no EKS cluster exists; the
staging ECS cluster exists with zero running services — i.e. both
`environment_active` flags are currently false, confirming the TTL
sweep/manual deactivation is working as designed.

**Persistent baseline, measured from six clean non-activation days
(2026-09-11 through 2026-09-16, after the last staging run and before this
session) at $0.176–$0.240/day, averaging $0.187/day ≈ $5.60/month:**
Secrets Manager $4.80/month (see the corrected count above) dominates; ECR
image storage is real but small at current image counts (~12.7 GB across all
three repos today, bounded by the 20-image lifecycle policy) — roughly
$0.26–$1.27/month depending on how close each repo sits to its cap; Aurora
storage, S3 (27 MB total, entirely in the development bucket — staging and
production both hold zero objects), CloudWatch Logs at current ingestion
volume, and development's always-live API Gateway/Lambda are each near-zero
at this data/traffic scale and did not move the daily total measurably.
Task 6's structured logging did not produce a measurable cost increase: the
development worker's log group (the only one carrying real per-request
volume) holds 16.5 MB at 7-day retention, which prices to a few cents a
month.

**The $20 "80% of budget" tension in `docs/PHASE_3_4_PLAN_REVIEW.md:64-66` is
resolved, not present in the real deployment.** `packages/config`'s
`USER_MONTHLY_SPEND_LIMIT_USD` Zod default is `20`, and `.env.example` repeats
it — but every environment that can actually spend real money overrides it to
**$5**: `infra/terraform/environment/variables.tf:105-108` and
`infra/terraform/production/variables.tf` both default the Terraform variable
of the same name to `5` (no `.tfvars` override raises it), and
`.github/workflows/deploy-development.yml:145` injects
`USER_MONTHLY_SPEND_LIMIT_USD:"5"` directly into the development web Lambda's
environment alongside the rest of its runtime config. The $20 figure is
reachable only by running `npm run dev` locally with a real key manually set
and no override in a local `.env` — a case CLAUDE.md/AGENTS.md already
discourage (`OPENAI_API_KEY` should stay empty outside deliberate manual
verification). The real enforced ceiling everywhere real spend can happen is
**$5/user/month**, not $20.

**Reconciled total, current scale (single tester, pre-public-usage — P4.5
gates public usage):** persistent baseline $5.60 + the $5 AI ceiling = **$10.60
/month** steady state with development always-live and staging/production
both inactive, as they are today. Headroom to the $25 target: **$14.40
/month** before any staging or production activation.

**Staging activation marginal cost**, measured from real historical runs
(`gh run list --workflow=deploy-staging.yml`) isolated to days with no
production attempt running concurrently: 2026-09-09 ($0.27 above baseline,
one run) and 2026-09-10 ($0.85 above baseline, two runs → ~$0.43/run) — call
it **$0.30–0.45 per full activate → migrate → deploy → smoke-test →
deactivate lifecycle** (each historical run completed in 15–35 minutes end to
end). Declared allowance: **up to 10 hours of staging activation per month**
(roughly 15–20 rehearsal runs at this size) ≈ $6–9/month, comfortably inside
the $14.40 headroom. `deploy-staging.yml` is `workflow_dispatch`-only as of
the session recorded above this one, so this is no longer driven by push
frequency — it is a deliberate cadence the maintainer controls.

**Production rehearsal hours, stated separately, as the roadmap requires:**
`gh run list --workflow=deploy-production.yml` shows all five historical
attempts (2026-09-06/07) failed, none completed the full lifecycle — P2.6
Task 1's rehearsal is still gated behind issues #8/#9/#10 per
`docs/ROADMAP.md`. There is no successful run to measure a real per-hour
figure from, and the failed-attempt days are confounded with concurrent
staging activity in the Cost Explorer data, so no clean number is
extractable yet. Planning-level estimate only, from the EKS/NAT/ALB rate
card (not measured): roughly $0.50–1.00 per hour of production activation
(EKS control plane alone is $0.10/hour). Revisit with a real figure once a
rehearsal actually completes.

**Projected total in a month that uses both declared allowances:** $10.60
baseline + ~$7.50 (mid-range, 10 hours staging) + ~$3 (a few hours of
production rehearsal) ≈ **$21/month — under the $25 target with roughly $4
of margin.** No scope, hour, or allowance reduction is needed at today's
single-tester scale; the $20-vs-$5 correction above is what closes the gap
the plan review flagged, not a new restriction. This margin assumes the
AI-cap contribution stays at one active tester — re-check it before P4.5
enables public usage, since aggregate AI spend scales with real user count
while the $5-per-user ceiling stays fixed per user, not per account.

**Still unresolved, carried forward rather than guessed at:**

- **Where the development database is hosted and billed.** It is external to
  these Terraform roots ("managed externally," this file's AWS topology
  section) and its cost is outside AWS Cost Explorer entirely. This session
  did not identify the provider — reading the stored connection string to
  extract just the hostname was blocked by this session's own safety
  controls (Bash permission classifier), which is the correct outcome for an
  agent reading a stored secret rather than something to route around. The
  maintainer should state which provider hosts it and its monthly cost so it
  can be added to the baseline above.
- **Real historical OpenAI spend versus the $5 ceiling.** This session had no
  OpenAI billing API access, so the $5 figure used throughout is the
  enforced application-level ceiling, not measured actual spend. Actual spend
  to date is bounded well below it, since only manual test scans have run
  against any deployed environment so far — but that is an inference from
  usage patterns, not a pulled number.
