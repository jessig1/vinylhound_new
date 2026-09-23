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

Apply bootstrap once with an AWS administrator identity — still true for
_who_ applies it, though as of 2026-09-22 its own state lives in the same S3
bucket it creates (`environments/*.tfstate` for the other three roots,
`bootstrap/terraform.tfstate` for itself), not a local file (see "Platform
delivery inventory" below for the migration). All environment work then uses
GitHub OIDC. Lambda roles, ECS task roles, and EKS Pod Identity roles
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
Migrations use the application's bounded, CA-verified database configuration
and must remain compatible with the previous image. Almost every migration in
this repository is forward-only by convention (no `-- Down Migration` section,
so `node-pg-migrate down` refuses to run it) and an operator rollback redeploys
previous ECR digests without reversing one. Migrations `021`/`022` (P4.2 Task
7's scan/core physical split, ADR-0030) are the sole exception with a real,
tested down path — see "Scan/core schema and role rollback" below before
reversing either.

Before the first deployment, populate the database URL (development only),
the scan/core database role URLs (development only — staging/production
generate theirs in Terraform), Clerk secret, Clerk publishable key, and
OpenAI key containers named by each root's outputs. Never put those values in
Terraform variables or GitHub secrets.

## Platform delivery inventory (P4.3 Task 2)

Full accounting of the four Terraform roots' backend keys, locks, IAM trust,
configuration, and owning workflows, verified against source (not just
ADR-0031's own "current state" summary, which itself says it is a starting
point, not a completed inventory). See
[ADR-0031](decisions/0031-platform-delivery-repository-split.md) for the
target shape this inventory feeds into (P4.3 Task 3's actual repository
split) and `docs/roadmap/p4.3-platform-delivery.md` for the task itself.

### bootstrap

- **Backend**: as of 2026-09-22, `s3` — bucket `vinylhound-tf` (its own
  output, self-referential since bootstrap creates this bucket), key
  `bootstrap/terraform.tfstate`, region `us-east-1`, hardcoded directly in
  `infra/terraform/bootstrap/versions.tf` rather than supplied via
  `-backend-config` at init time like the other three roots, since bootstrap
  has no workflow to inject it. **Before this date it had no backend block
  at all** — this checkout had accumulated real AWS resources (OIDC
  provider, IAM roles, ECR repos, the state bucket itself) with no matching
  local state file anywhere, discovered and recovered during P4.3 Task 3
  preparation by importing all 21 bootstrap-owned resources into a fresh
  local state, then migrating that local state into the new S3 backend
  (`terraform init -migrate-state`) once real applies were unblocked (see
  `docs/HANDOFF.md`'s 2026-09-22 entries for the full recovery procedure).
  Still applied only manually, with an AWS administrator identity
  (`infra/terraform/bootstrap/README.md`) — **no workflow ever plans or
  applies bootstrap**; `platform.yml`'s `terraform` job only runs `init
-backend=false` + `validate` (syntax-only) against it.
- **Locking**: native S3 lockfile (`use_lockfile = true`), same mechanism as
  the other three roots, key `bootstrap/terraform.tfstate.tflock` in the same
  shared bucket. Before the 2026-09-22 migration this was N/A (local state,
  single human operator, no possibility of a second concurrent writer).
- **IAM / OIDC trust** — bootstrap/main.tf defines every role in the account:
  - GitHub OIDC provider (`aws_iam_openid_connect_provider.github`,
    audience `sts.amazonaws.com`), subject prefix
    `repo:jessig1@13804284/vinylhound_new@1345526931`
    (`github_oidc_subject_prefix`, validated to start with `repo:`).
  - `vinylhound-github-plan`: trusted for `${prefix}:pull_request` and
    `${prefix}:ref:refs/heads/main` (the latter currently unused — no
    workflow assumes this role on a `main` push today, only on
    `pull_request`). Grants AWS-managed `ReadOnlyAccess` plus
    `s3:PutObject`/`s3:DeleteObject` on
    `${state_bucket_arn}/environments/*.tfstate.tflock` — a single wildcard
    covering all three non-bootstrap roots' lock objects, i.e. lock-write
    permission is shared/ungated per-root even though each root's lock
    object is distinct by key. In practice only ever used against the
    `environment` (staging) root (`platform.yml`'s `terraform-plan` job).
  - `vinylhound-github-<env>-deploy` (`for_each` over development/staging/
    production): each trusted only for its own exact GitHub Environment
    subject (`${prefix}:environment:<env>`, `StringEquals`). All three share
    one identical, broad inline policy (`ec2:*`, `ecs:*`, `eks:*`, `ecr:*`,
    `lambda:*`, `rds:*`, `s3:*`, `secretsmanager:*`, `iam:*Role*`/`*Policy*`
    actions, ... on `Resource = "*"`) — the one-axis-only narrowing
    ADR-0031 already flags for its own two-axis fix.
- **Configuration**: `variables.tf` — `aws_region` (default us-east-1),
  `terraform_state_bucket` (required), `github_oidc_subject_prefix`,
  `create_github_oidc_provider`. `outputs.tf` — `terraform_state_bucket`,
  `ecr_repository_urls` (web/worker/worker-lambda/discovery),
  `github_plan_role_arn`, `github_deploy_role_arns` (map). These four
  outputs must be hand-seeded as GitHub repository/environment variables
  after every bootstrap apply (README).
- **Owning workflow**: none applies it; `platform.yml` validates its syntax
  only.

### development

- **Backend**: `backend "s3" {}` with only `use_lockfile = true` and
  `encrypt = true` in the file — bucket/region/key supplied at `terraform
init` time by `deploy-development.yml`'s "Initialize state" step:
  `bucket=${{ vars.TF_STATE_BUCKET }}`, `region=us-east-1`,
  `key=environments/development.tfstate`. No `backend.hcl.example` exists
  for this root (CI-init-only).
- **Locking**: Terraform's native S3 lockfile (Terraform ≥1.10), not
  DynamoDB — there is no DynamoDB table anywhere under `infra/` (confirmed
  by repository-wide search). The lock is the `.tflock` object next to this
  root's own state key in the shared state bucket.
- **IAM / OIDC trust**: `vinylhound-github-development-deploy`
  (`environment: development`), used for **both** the ECR image pushes
  (`web`, `worker-lambda`) and the Terraform apply — i.e. a plain `docker
push` runs under the same broad, `Resource = "*"` policy as the Terraform
  apply, the over-grant ADR-0031's narrower application-repository role is
  meant to fix.
- **Configuration**: `variables.tf` — `aws_region`, `domain_name`,
  `hostname`, `web_image`/`worker_lambda_image` (digest-pinned), `deployment_version`,
  `runtime_configured` (gates secret-dependent resources until injected),
  `budget_alert_email`. `outputs.tf` — `application_url`, Lambda function
  names, `image_bucket`, six queue/DLQ URLs, `runtime_secret_arns` (map),
  consumed by a post-apply `aws lambda update-function-configuration` step
  that reads Secrets Manager directly (Terraform never sees secret values).
- **Owning workflow**: `deploy-development.yml` only — triggers `push` to
  `main` and `workflow_dispatch`, chained off `ci.yml` via a same-repository
  `workflow_call` (the mechanism ADR-0031's split replaces with a
  cross-repository `repository_dispatch`). Concurrency group
  `development-platform`. Also validated (syntax-only) by `platform.yml`.

### environment (staging)

**As of 2026-09-23, this root's writer transferred to
[vinylhound-platform](https://github.com/jessig1/vinylhound-platform)** —
the inventory below describes the pre-transfer state (still accurate for
the backend key, locking, and configuration, which are unchanged) except
where noted. `vinylhound_new`'s own `deploy-staging.yml` is now frozen
(disabled) and `platform.yml`'s `terraform-plan` job is guarded with
`false &&`; both are kept for reference/rollback only. See
`docs/roadmap/p4.3-platform-delivery.md`'s Task 3 entry for the full
transfer record, including two real bugs (a missing `servicediscovery:*`
IAM permission and a missing `--experimental-transform-types` flag on ECS
command overrides) found and fixed while getting the real cutover deploy to
succeed — the first real deploy staging has ever completed for P4.1's
discovery service and P4.2 Task 7's scan/core split.

- **Backend**: `backend "s3" {}`, same `use_lockfile`/`encrypt`-only shape.
  The only root with a `backend.hcl.example` (for local use), but its
  placeholder key comment ("replace-with-staging-or-production") is stale —
  `variables.tf` hard-validates `var.environment == "staging"` only; the
  `production.tfstate` key belongs exclusively to the separate `production`
  root. In CI, two different workflows initialize this root against the
  same key (`environments/staging.tfstate`, same bucket): `platform.yml`'s
  `terraform-plan` job and `deploy-staging.yml`'s apply.
- **Locking**: Terraform native S3 lockfile, same shared bucket, key
  `environments/staging.tfstate`.
- **IAM / OIDC trust**: two roles touch this root.
  - `vinylhound-github-plan`, used by `platform.yml`'s `terraform-plan` job
    (plan only, never apply) — gated on `pull_request` events from a
    same-repository head, but notably this job sets **no `environment:`
    block**, so it bypasses GitHub Environment protection rules (required
    reviewers, wait timers) that every deploy job gets.
  - `vinylhound-github-staging-deploy` (`environment: staging`), used by
    `deploy-staging.yml` for the full build/push/apply/migrate/deploy/
    verify/promote sequence.
  - **Correction to ADR-0031's Context section**: that ADR states
    "`platform.yml` validates/plans all four Terraform roots on PRs." Only
    half true — `platform.yml`'s `terraform` job runs `validate` (syntax
    only, `-backend=false`, no state) against all four roots, but its
    separate `terraform-plan` job runs an actual `terraform plan` against
    **only** this root. There is no automated real plan for bootstrap,
    development, or production.
- **Configuration**: `variables.tf` — `environment` (locked to
  `"staging"`), `environment_active` (the scale-to-zero switch, default
  false), `deploy_services` (requires `environment_active`), `vpc_cidr`,
  `domain_name`/`hostname`, `web_image`/`worker_image`/`discovery_image`
  (digest-pinned only when active), `database_max_acu` (0.5-8, default 2),
  and the app cost-guard knobs (`user_daily_analysis_limit`,
  `user_active_scan_limit`, `user_monthly_spend_limit_usd`,
  `scan_cost_reservation_usd`). `outputs.tf` — `application_url` (null
  unless active), `environment_active`, `ecs_cluster_name`,
  `db_cluster_identifier`, `runtime_secret_arns` (map, including
  `scan_database_url`/`core_database_url` since P4.2 Task 7).
- **Owning workflows**: `platform.yml` (`terraform-plan`, PR-triggered,
  plan only); `deploy-staging.yml` (`workflow_dispatch` only, no push
  trigger, concurrency group `staging-platform`).

### production

**As of 2026-09-23, this root's ownership-transfer plumbing exists in
[vinylhound-platform](https://github.com/jessig1/vinylhound-platform), but
`vinylhound_new` remains the sole real writer** — deliberately, unlike
`development`/`environment`, since issue #8 still gates a real production
activation rehearsal. `vinylhound-github-production-deploy` is dual-trusted
(both repositories); `vinylhound_new`'s own `deploy-production.yml`/
`deactivate-environment.yml` are still live and un-frozen. A plan-only
rehearsal from the platform repository returned "No changes" against
production's real (inactive) state, after this session applied production's
own pending foundation-level drift (16 resources: scan/core secrets,
confirmation queues, `discovery_shared_secret` — the same never-applied
P4.1/P4.2 Task 7 drift staging had) directly, with `environment_active`
staying `false` throughout. See `docs/roadmap/p4.3-platform-delivery.md`'s
Task 3 entry for the full record. The inventory below otherwise still
describes the current state accurately (backend key, locking,
configuration are unchanged).

- **Backend**: `backend "s3" {}`, same shape, no `backend.hcl.example`.
  Three workflow steps initialize it against the same key
  (`environments/production.tfstate`, same bucket): `deploy-production.yml`,
  and `deactivate-environment.yml`'s two paths (normal and
  `skip_activation_check`-forced).
- **Locking**: Terraform native S3 lockfile, same bucket, key
  `environments/production.tfstate`. The only root with a documented manual
  unlock runbook step (`stale_lock_id` input, `terraform force-unlock
-force`, `deactivate-environment.yml`) — see [issue #9](https://github.com/jessig1/vinylhound_new/issues/9)
  for the incident that motivated it.
- **IAM / OIDC trust**: `vinylhound-github-production-deploy` only, used by
  both `deploy-production.yml` (`environment: production`) and
  `deactivate-environment.yml` (`environment: production`). No plan role is
  ever used against production.
- **Out-of-Terraform state, not mentioned by ADR-0031**: SSM parameters
  `/vinylhound/production/active` and `/vinylhound/production/expires-at`
  gate activation/deactivation decisions independently of Terraform's own
  `environment_active` variable and independently of the state lock — a
  real operational coupling a future platform-repository split has to
  preserve, since it is account/region-global state read by both deploy
  workflows.
- **Configuration**: `variables.tf` — `aws_region` (locked to `us-east-1`
  so the CloudFront certificate stays valid), `environment_active`,
  `vpc_cidr`, `domain_name`/`hostname`, `kubernetes_version` (nullable),
  `database_max_acu` (0.5-16, default 4), the same cost-guard knobs as
  staging. `outputs.tf` — `application_url`, `environment_active`,
  `eks_cluster_name` (null unless active), `db_cluster_identifier`,
  `database_ca_base64` (sensitive RDS CA bundle), `runtime_secret_arns`
  (map), and a sensitive `kubernetes_runtime` object bundling the values
  `kubectl create configmap` needs.
- **Owning workflows**: `deploy-production.yml` (`workflow_dispatch` only,
  requires `commit_sha`/`ttl_hours`/`break_glass` inputs);
  `deactivate-environment.yml` (hourly `schedule` plus `workflow_dispatch`
  with `force`/`skip_activation_check`/`stale_lock_id` escape-hatch
  inputs — see [issue #10](https://github.com/jessig1/vinylhound_new/issues/10)
  for the unreviewed-hardening tracking on those inputs). Both share
  concurrency group `production-platform`, so they cannot run concurrently.

### Cross-cutting: ECR, the digest-promotion contract, and locking

- **ECR repositories** (`bootstrap/main.tf`): `vinylhound-web`,
  `vinylhound-worker`, `vinylhound-worker-lambda`, `vinylhound-discovery`,
  all `image_tag_mutability = "IMMUTABLE"`, scan-on-push, AES256 encryption.
  (`vinylhound-discovery` was missing from the real account until the
  2026-09-22 bootstrap apply below created it — config had included it in
  the `for_each` since at least P4.1, but bootstrap had never been
  re-applied since; real drift, not a design change.)
  Lifecycle policy retains only the newest 20 images by count per
  repository — a latent interaction with the promotion contract below that
  ADR-0031 does not discuss: past 20 accumulated tags, an older
  `staging-passed-<sha>` tag could in principle be expired before it is
  promoted. Not observed in practice; worth keeping in mind if promotion
  cadence ever slows relative to build cadence.
- **Digest-promotion contract, exact tags**: `${sha}` (development only,
  produced/consumed within `deploy-development.yml`); `${sha}-staging`
  (produced by `deploy-staging.yml`'s build/push steps, idempotent via an
  `aws ecr describe-images` existence check before rebuilding);
  `staging-passed-${sha}` (produced by `deploy-staging.yml` only after the
  post-deploy smoke test passes, by re-tagging the exact same digest via
  `aws ecr put-image`; consumed by `deploy-production.yml`'s
  `--image-ids imageTag=staging-passed-<commit_sha>` resolution). Production
  never builds an image.
- **No DynamoDB lock table exists anywhere in this repository.** All
  locking is Terraform's native S3 lockfile feature, sharing one state
  bucket (bootstrap's `terraform_state_bucket` output) with per-root
  `.tflock` objects keyed by each root's own state key.

## Emergency production deactivation inputs (issue #10 hardening)

`deactivate-environment.yml`'s `skip_activation_check` and `stale_lock_id`
`workflow_dispatch` inputs are an emergency escape hatch added during the
[issue #9](https://github.com/jessig1/vinylhound_new/issues/9) incident
(2026-09-07), when the SSM `/vinylhound/production/active` flag and real AWS
state drifted out of sync after a crashed run's OIDC session expired
mid-teardown. This section is the runbook [issue #10](https://github.com/jessig1/vinylhound_new/issues/10)
asked for, since there is no existing pattern in this repository for testing
workflow YAML logic directly.

**When to use `skip_activation_check`**: only when `deactivate-environment.yml`'s
normal path (both the hourly `schedule` and a plain `workflow_dispatch`) is
reporting production as already inactive while the AWS Console shows
EKS/ALB/CloudFront/WAF/NAT still live. Confirm this mismatch directly
(`aws ssm get-parameter --name /vinylhound/production/active`, `aws eks
list-clusters`) before dispatching — this input bypasses the SSM gate
entirely, not just a slow check.

**When to use `stale_lock_id`**: only after confirming no other production
Terraform operation is in flight. The `production-platform` concurrency
group already serializes every GitHub Actions run of `deploy-production.yml`
and `deactivate-environment.yml` against each other, so the only real race
this input can hit is a `terraform apply`/`plan` run from someone's own
machine against the same backend key
(`environments/production.tfstate`) outside GitHub Actions entirely. Ask
before force-unlocking if there's any doubt; `terraform force-unlock` on a
live lock does not stop the apply holding it, it only lets a second,
conflicting apply start.

**What changed in this session's hardening (2026-09-22)**: previously,
`skip_activation_check` skipped straight to the forced Terraform apply with
no Kubernetes drain at all, because the drain/connect/remove steps are keyed
off the normal path's `deactivate` output, which `skip_activation_check`
exists specifically to bypass — worse than the existing `force` input, which
at least attempts a drain first. A new "Attempt best-effort drain before
forced teardown" step now runs whenever `skip_activation_check` is set: it
resolves `eks_cluster_name` from the already-initialized Terraform state,
skips cleanly (via `continue-on-error: true`, non-fatal either way) if the
cluster is missing or unreachable, and otherwise scales `web` to zero and
polls the worker's `drain-check` up to five times over 2.5 minutes (short
by design — this path exists for genuine emergencies, so it must not block
the forced teardown for as long as the normal 10-minute drain does) before
the existing forced-apply step runs regardless of the drain outcome.

**Not changed, and why**: this session did not add automated verification
that a `stale_lock_id` belongs to a genuinely dead run, since the only
uncovered race (a manual `terraform apply` outside GitHub Actions) has no
purely code-side fix — it is an operational discipline question, addressed
here by documentation rather than by workflow logic. This session also did
not remove or further restrict either input, per the issue's own "reasonable
argument for keeping it either way" — now that issue #9's longer OIDC
session duration (14400s, up from the 3600s default) makes the triggering
failure mode rarer, but a future crash (network blip, runner failure) can
still orphan a lock or desync the SSM flag.

## Scan/core schema and role rollback (P4.2 Task 7, ADR-0030)

Migration `021_scan_core_schema_split.sql` (additive: two schemas, two roles,
the `library_items.confirmed_release` backfill, the `scan.account_deletions`
backfill) and `022_scan_core_writer_switch.sql` (drops the eight FKs the
schema/role split made unenforceable across the boundary) both carry a real
`-- Down Migration` section, verified by driving it against seeded in-flight
state rather than an empty database. **Re-verified end to end (P4.3 Task 4,
2026-09-23) against the local dev database's own real, accumulated data**
(not a fresh/empty database — 49 scans, 2187 outbox messages, 4921 library
items already present from months of prior local testing) using the new
`apps/worker/dist/rollback.js` tooling itself, the same code path a deployed
environment now uses:

1. Seed one `pending` `scan_confirmations` row, one undelivered
   `scan.confirmed.v1` `outbox_messages` row, one undelivered
   `confirmation_receipts` row, and one account with `deletion_requested_at`
   set — the same shapes `packages/database/src/schema.integration.ts`'s own
   test suite seeds for the pipeline's other tests. **2026-09-23 re-run**:
   seeded through the real `confirmScan`/`processScanConfirmation` repository
   functions directly (not hand-written SQL, to guarantee every FK/shape
   constraint is genuinely satisfied), confirmed via direct query before
   proceeding.
2. **Local dev checkout**: `npx node-pg-migrate down --count 1
--migrations-dir packages/database/migrations --migrations-table
vinylhound_migrations` (from `packages/database`, or with
   `--migration-dir`/table flags adjusted for the repo root). **A deployed
   environment** (staging/production) has no `npx` and no dev dependencies
   in its runtime image (P4.3 Task 4: found this gap live, since this
   runbook had only ever been driven from a local checkout before) — use
   `bash scripts/aws/run-worker-command.sh rollback 1` instead, which runs
   the same reversal through `apps/worker/dist/rollback.js`
   (`rollbackDatabaseMigrations` in `packages/database/src/migrations.ts`,
   reusing `runDatabaseMigrations`'s own SSL-aware connection options rather
   than re-deriving TLS setup for a bare CLI invocation). Either path
   reverses `022` alone: the eight FKs come back `NOT VALID` (a row orphaned
   while they were absent must not make the rollback itself fail) and the
   three replacement indexes are dropped. Confirm zero rows were lost, then
   run `ALTER TABLE ... VALIDATE CONSTRAINT <name>` for each of the eight
   once you have reconciled any row that would fail it (in practice, none
   should: the FKs these replace were already unenforced in the direction
   that matters for as long as 022 was live). **Now built for a deployed
   environment** too: `bash scripts/aws/run-worker-command.sh validate-fks`
   runs `apps/worker/dist/validate-fks.js`
   (`validateScanCoreForeignKeys` in `packages/database/src/migrations.ts`,
   same admin connection as migrate/rollback — table ownership, not the
   scan-/core-scoped app roles, is what `VALIDATE CONSTRAINT` needs) and
   reports a per-constraint `valid`/`error` result rather than stopping at
   the first failure, so an operator can see exactly which of the eight
   still have a real violation to reconcile. **2026-09-23 re-run**:
   `apps/worker/dist/rollback.js 1` reversed `022` cleanly against the local
   dev database's real data with zero row-count change across every table.
   All eight FKs came back `NOT VALID`, confirmed directly against
   `pg_constraint`. Validating all eight found exactly four failures — real,
   pre-existing orphaned rows from unrelated prior local testing (one scan
   with an orphaned copy/library-item/release triple, six scans whose user
   had since been fully deleted), traced and confirmed unrelated to the
   freshly-seeded drill data, which validated cleanly wherever exercised.
   This is the same shape of result the original local drill found (some
   real accumulated rows genuinely can't validate) — proof the `NOT VALID`
   design choice is load-bearing, not defensive-programming theater.
3. A second `--count 1` (local) / `rollback 1` (deployed) call reverses
   `021` too, once the FK validation above is done — deliberately a second,
   separate call rather than `--count 2`/`rollback 2` in one shot, so there
   is a real inspection point between reversing `022` and `021`. Both
   schemas move back to `public`,
   `library_items.confirmed_release` and `scan.account_deletions` are
   dropped, and every `search_path` resets. The two roles are left in place
   (they own nothing; the next forward `npm run db:migrate` re-`ALTER`s them
   harmlessly). **2026-09-23 re-run**: confirmed both tables' schema moved to
   `public` and every other table's row count matched exactly (49 scans,
   2187 outbox messages, 4921 library items, unchanged). **Real finding: this
   step is not fully loss-free.** `021`'s down migration unconditionally
   `DROP TABLE IF EXISTS scan.account_deletions`, and its up migration only
   repopulates it from `core.users` rows that currently have
   `deletion_requested_at` set. A tombstone for an account whose deletion had
   already **fully completed** before the rollback (its `core.users` row
   already gone, by design — ADR-0018's "removed means unconfirmed" audit
   record) has no source row left to re-derive it from, so it is
   permanently lost across a rollback/roll-forward cycle even though no
   currently in-flight data was touched. Confirmed directly: the local dev
   database had 3 `scan.account_deletions` rows before this drill (from
   unrelated prior sessions' completed-deletion testing) and 1 after a full
   rollback + forward re-apply (only the drill's own still-pending deletion
   survived). This was never exercised by the original local drill, whose
   seeded deletion request was itself still pending when it checked the
   table. Not fixed this session — flagged here and in
   `docs/decisions/0030-scan-core-physical-split.md` for the maintainer's
   own judgment on whether it matters (this table appears to be an internal
   audit aid, not user-facing state, but the loss is real and worth a
   conscious call, not a silent gap).
4. Run the seeded in-flight confirmation through `reconcileScanConfirmation`
   against the rolled-back, single-schema database using the pre-cutover
   (single-connection) code path — it must still complete and the library
   item must still appear. This is the concrete proof behind the roadmap's
   "test rollback with in-flight events and reconciliation": the recovery
   mechanism the async pipeline already relies on (ADR-0028) also recovers
   correctly on the far side of an emergency rollback, not just going
   forward. **In a deployed environment this step needs a real pre-cutover
   application image already available** (P4.3 Task 4 found staging has
   none — its first-ever successful real deployment was the cutover itself,
   so there was nothing pre-cutover to have deployed) — build one before
   attempting this step there, e.g. via `build-staging-images.yml` at the
   commit immediately before `021`/`022` were added
   (`git log --oneline --diff-filter=A -- packages/database/migrations/021_scan_core_schema_split.sql`'s
   parent). Dispatching that workflow needs a ref where it exists, which the
   pre-cutover commit predates — push a temporary branch at that commit with
   only the current workflow file added (no application source changed)
   rather than reverting the schema-split commit forward onto `main` (an
   earlier session's attempt at that produced unmanageable conflicts across
   nearly every file in `apps/web`). This step is straightforward against a
   local checkout, which just runs whatever commit is checked out directly,
   no image involved.
   **2026-09-23 re-run**: used a `git worktree add` checked out at that
   parent commit (`160073a9cd158aba89fc421153b89d1c9557549a`) as a
   subdirectory of the main checkout (so its bare-specifier imports still
   resolve node_modules by walking up, without a separate `npm install`) —
   called the pre-cutover `reconcileScanConfirmation(db, ...)` (its old,
   single-`Database`-argument signature) directly against the rolled-back
   database. It completed the drill's seeded confirmation end to end: status
   moved from `pending` to `completed`, and a real library item/copy were
   created. Concrete proof the recovery mechanism (ADR-0028) still works on
   the far side of an emergency rollback, exactly as this runbook always
   claimed, now actually exercised rather than only designed.
5. Re-apply `npm run db:migrate` (forward) and confirm the
   `library_items.confirmed_release` backfill is idempotent — re-running the
   `UPDATE ... FROM scan_confirmations` a second time must leave every row
   unchanged. **2026-09-23 re-run**: forward migration re-applied cleanly;
   every table's row count matched the pre-rollback snapshot exactly except
   `scan.account_deletions` (see step 3's finding above).

**Never roll back `022` alone while any application instance is still running
code written for the post-cutover (two-connection) shape** — that code no
longer performs the single-transaction account deletion or confirmation
writes the restored FKs assume, so a rollback must always pair with
redeploying the pre-Task-7 application image at the same time, exactly like
any other schema/application coupled release.

## Backup and restoration

Managed PostgreSQL must retain daily backups and point-in-time recovery for at
least 30 days. Object storage versioning protects against accidental object
deletion; its retention must be at least the database recovery period. Test a
restore monthly and after a database-provider change:

1. Restore a production backup to an isolated database and use separate,
   non-production storage credentials.
2. Apply `npm run db:migrate` (needs `DATABASE_URL` plus `SCAN_DATABASE_URL`/
   `CORE_DATABASE_URL` pointed at the restored database's own scan/core
   roles, P4.2 Task 7), start one web instance and one worker against the
   restored database, and verify an account export and a representative
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
`apps/web` API route logs one `{"event":"http_request",...}` line (`route`,
`method`, `status`, `durationMs`, `requestId`, and `correlationId` if the
caller sent one) via a shared `withRoute` wrapper
(`apps/web/src/server/http.ts`), so this is no longer only true of the durable
IDs — an inbound `x-request-id` header is validated (bounded length/charset,
dropped rather than rejected if malformed) and forwarded as `correlationId`
onto the outbox row, the job payload, and the `scan_attempts` row the worker
writes, so one caller-supplied trace value can be grepped across the HTTP
request, the queued job, and the analysis attempt. It is untrusted metadata
only: never used for lookups, joins, or authorization. The upload-complete
route additionally logs `{"event":"upload_complete_timing",...}` with
`uploadPhaseDurationMs` (readback plus validation) and
`normalizationPhaseDurationMs` (deriving and storing the analysis/thumbnail
variants) separated; the worker logs `{"event":"scan_analysis_timing",...}`
with `storageFetchDurationMs` and `providerCallDurationMs` split out from the
existing bundled `scan_attempts.duration_ms`.

These three are each written with one `console.info(JSON.stringify(...))`
call — not `console.info(prefix, object)` — because the latter genuinely was
not JSON-capable in the Lambda runtime: Node's default object inspection
wraps a multi-key object onto several lines, and Lambda's log capture turns
each printed line into its own CloudWatch log event, splitting one request's
fields across unrelated events and defeating both `grep` and CloudWatch Logs
Insights' automatic JSON field discovery (which requires the whole message to
parse as one JSON value). This was found and fixed during P3.5 Task 3 after
pulling the live development Lambda's real logs and finding `http_request`
events split across up to eight separate CloudWatch events each — see
"Reconciled performance and cost signals" below for the real numbers this
produced and the Logs Insights queries that now work against the fixed
format. `apps/worker/src/ops.ts`'s `drain_check`/`queue_reconciliation` lines
already used this one-call JSON.stringify pattern; the three timing lines now
match it. Other `console.info`/`console.error` calls across the codebase
still pass a short prefix plus a small object and were left alone — most stay
on one line in practice because they carry few short fields, but this is
incidental to Node's line-wrapping heuristics, not guaranteed; treat any log
line an operator needs to query reliably in Logs Insights as needing this
same one-call JSON.stringify treatment, not just these three. Alert on:

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

## Reconciled performance and cost signals (P3.5 Task 3, 2026-09-18)

Two real sources, not estimates: persisted `scan_attempts`/`outbox_messages`
rows (via the new `scripts/metrics/reconcile.ts`, `npm run
metrics:reconcile`) for attempt duration, queue age, end-to-end latency,
error rate, and estimated AI cost; and CloudWatch Logs Insights against the
live, always-on `vinylhound-development-web`/`-worker` Lambdas' real logs
(after the maintainer reauthenticated an expired AWS CLI session, the same
step P3.5 Task 1 needed) for API request percentiles, error rate, and
upload/normalization timing — the two signal families the roadmap task
description splits between "persisted attempts" and "structured
logs/Logs Insights."

### Persisted attempts (local development database)

`scripts/metrics/README.md` has the full method. Committed sanitized run:
`scripts/metrics/results/2026-09-18T14-39-31-218Z/`. 69 real attempts spans
17.15 days (2026-08-26 to 2026-09-13); 67 are real `gpt-5.6-terra` calls from
manual local `npm run dev` testing (the other 2 are an
`integration-test-model` row with no token counts, excluded from cost and
shown separately so it cannot dilute the real figures):

| Signal (ms)                   | n   | p50  | p95   | p99     | mean     |
| ----------------------------- | --- | ---- | ----- | ------- | -------- |
| attempt duration              | 67  | 3293 | 16329 | 23327   | 5094.22  |
| queue age (enqueue→pickup)    | 67  | 4000 | 16000 | 2559000 | 47134.33 |
| end-to-end (enqueue→complete) | 67  | 8000 | 27000 | 2563000 | 52283.58 |

Error rate: 0/69 — no real local attempt has failed to date, so no real
failure-mode latency or error-rate sample exists yet from this source. Total
input/output tokens 62,597 + 12,540; **estimated AI cost $0.2757** using the
same `estimateTokenUsageCostUsd` pricing function `/usage` and batch cost
summaries already use, just applied across the full available history
instead of the endpoint's fixed 30-day contract window.

**This is local development usage, not the deployed Lambda's own spend** —
the deployed development Lambda's database is external/managed and was not
queried here (Task 1's "where the development database is hosted" unknown is
still open). It is a real, useful data point regardless: it is direct
evidence, not an inference, that manual testing against a real key stays
far under the $5/user/month ceiling described above.

The queue-age and end-to-end p99/max figures (2,559–2,563 seconds — about 43
minutes) are real, not a measurement artifact, but they measure **sporadic
manual testing cadence, not queue pressure**: the local worker process is not
continuously running between sessions, so a scan submitted, then picked up
only once the developer next started the worker, produces a long but
meaningless "queue age" sample. Read the p50 (4 seconds picked-up, 8 seconds
end-to-end) as the more representative figure for an actively-running worker;
the tail is a reminder that abandoned or long-idle jobs need the worker
actually running, not a latency regression. A future run against a database
with continuous worker uptime (e.g. a deployed environment, once its database
is reachable) would not have this artifact.

### API requests and upload timing (live development Lambda, real traffic)

Pulled via CloudWatch Logs Insights against `/aws/lambda/
vinylhound-development-web` (7-day retention; observed window 2026-09-11
20:16 to 2026-09-13 20:08 UTC — two real manual testing sessions, the only
traffic within the retained window). Reconstructed once, by hand, from the
pre-fix multi-line log format described above (each event's fields were
spread across several separate CloudWatch log lines); the equivalent queries
below are what to run going forward now that the format is fixed.

**111 real `http_request` events, 0 errors (all `200`/`201`/`202`):**

| Signal (ms)              | n   | min | p50  | p95  | p99  | max  |
| ------------------------ | --- | --- | ---- | ---- | ---- | ---- |
| all routes               | 111 | 124 | 621  | 1112 | 1702 | 3361 |
| `batches.get`            | 41  | 431 | 696  | 1218 | —    | 1445 |
| `scans.images.thumbnail` | 25  | 124 | 551  | 707  | —    | 772  |
| `scans.get`              | 15  | 307 | 308  | 344  | —    | 344  |
| `scans.create`           | 6   | 606 | 1063 | 1702 | —    | 1702 |
| `scans.uploads.create`   | 6   | 434 | 480  | 512  | —    | 512  |
| `scans.uploads.complete` | 6   | 485 | 660  | 3361 | —    | 3361 |
| `scans.submit`           | 6   | 649 | 717  | 951  | —    | 951  |
| `quota.get`              | 4   | 241 | 279  | 300  | —    | 300  |
| `batches.create`         | 2   | 505 | 746  | —    | —    | 746  |

No real error sample exists in this window either — error-rate alerting has
not yet been exercised against a real 4xx/5xx from this environment.

**6 real `upload_complete_timing` events:** upload phase (readback +
validation) 93–1664ms (mean 435.5ms); normalization phase (deriving/storing
analysis + thumbnail variants) 132–1454ms (mean 369.3ms). One event
(`9be8d403…`) is a clear outlier at 1664/1454ms against five clustered
around 93–246/132–164ms — six samples is too few to call this a real
distribution, just a real observation that the two phases are normally
comparable in cost and occasionally both spike together (consistent with a
shared cause — cold storage/CPU — rather than one phase being
disproportionately expensive).

**4 real `scan_analysis_timing` events** (`/aws/lambda/
vinylhound-development-worker`, same window): total `durationMs` 10230,
22592, 29153, 47444 — real OpenAI `gpt-5.6-terra` calls, `storageFetchDurationMs`
consistently under 130ms each time, so essentially all of it is
`providerCallDurationMs` (10113–47354ms). This is 2–9× slower than the local
persisted-attempt mean above (5094ms) and far above the P3.5 Task 2
benchmark's synthetic 320–416ms p50/p95 — expected and not a regression: the
benchmark's worker never calls a real provider at all, and this Lambda path
adds real network round trips a local direct connection does not pay. Four
samples is too few to trust a percentile from; treat this as confirmation
that real provider latency is measured in seconds, not milliseconds, when
sizing timeouts and alert thresholds.

**Logs Insights queries for the now-fixed single-line JSON format** (replace
the reconstruction above going forward):

```
# API p50/p95/error rate/throughput by route, web log group
fields @timestamp, route, status, durationMs
| filter event = "http_request"
| stats count() as n,
        sum(status >= 400) as errors,
        pct(durationMs, 50) as p50,
        pct(durationMs, 95) as p95
        by route

# Upload/normalization phase split, web log group
fields uploadPhaseDurationMs, normalizationPhaseDurationMs
| filter event = "upload_complete_timing"
| stats pct(uploadPhaseDurationMs, 50) as uploadP50,
        pct(normalizationPhaseDurationMs, 50) as normalizationP50,
        count() as n

# Attempt duration split, worker log group
fields storageFetchDurationMs, providerCallDurationMs, durationMs, outcome
| filter event = "scan_analysis_timing"
| stats pct(durationMs, 50) as p50,
        pct(durationMs, 95) as p95,
        count() as n by outcome
```

These rely on CloudWatch Logs Insights' automatic JSON field discovery
(`event`, `route`, `durationMs`, etc. are usable directly, no `parse`
needed) — which only works because the fix above makes each event one
self-contained JSON line. Query cost is negligible at today's volume
(~300KB scanned for the reconstruction above, well under a cent).

### Queue age: reuse native SQS metrics, add nothing

`ApproximateAgeOfOldestMessage` and `ApproximateNumberOfMessagesVisible` are
already alarmed (`infra/terraform/environment/monitoring.tf`'s `queue_age`
alarm at 300s/5min; `infra/terraform/production/monitoring.tf`'s `queue_age`
and `dlq` alarms) and already graphed on the operations dashboard
(`environment/monitoring.tf`'s "Queue" widget) — this satisfies the roadmap
task's "optional queue CloudWatch metrics" with infrastructure that already
exists; nothing new was added. The persisted-attempt queue age above (enqueue
to worker pickup, from `scan_attempts`/`outbox_messages`) is the complementary
application-level view of the same underlying signal, not a duplicate of it:
SQS's metric is queue-side (how long the oldest visible message has waited);
the persisted figure is per-attempt and survives after the message leaves
the queue.

**Deliberately left off:** `apps/worker/src/metrics.ts`'s
`startQueueMetricsPublisher` (custom `PutMetricData` calls for
`QueuePendingJobs`/`QueueOldestAgeSeconds`/`QueueFailedJobs` under the
`VinylHound` namespace) exists in code and has IAM permission wired
(`infra/terraform/environment/ecs.tf:129-132`) but `CLOUDWATCH_METRICS_ENABLED`
defaults `false` everywhere and was not turned on for this reconciliation —
this publisher was previously undocumented in this file. Enabling it would
add real, currently-unreconciled `PutMetricData` request cost on top of the
budget above; the native SQS metrics and the persisted-attempt figures
already answer this task's queue-age/duration questions without it, which is
exactly the "reuse ... rather than adding uncosted custom metrics" the
roadmap task calls for. Revisit only with an explicit budget decision, not as
a side effect of future instrumentation work.

### Telemetry retention and cost

CloudWatch Logs retention is unchanged by this task: development 7 days,
staging 7 days, production 30 days (figures and citations in "Persistent
spend inventory" above). The JSON.stringify fix incidentally reduces log
volume for these three lines — each `http_request` event was previously up
to eight separate CloudWatch log events (one per object key) and is now one
— but this session did not re-measure ingestion bytes/month to quantify that
saving; treat it as a directionally positive side effect, not a new figure to
budget against.

## Deterministic-stub versus capped live run, and worker concurrency (P3.5 Task 4, 2026-09-18)

New `scripts/concurrency/` (`npm run concurrency:compare`, full method and
configuration in its own `README.md`) drives the real HTTP submission
pipeline, then starts a configurable number of real worker processes with
`ANALYSIS_CONCURRENCY` split evenly across them, capturing every process's
own `{"event":"scan_analysis_timing",...}` line (single-line JSON as of the
P3.5 Task 3 fix above — this tool reads it directly from each worker's
stdout, since `scan_attempts` never persisted the storage-fetch/provider-call
split, only the bundled total). `mode=stub` runs the deterministic
`apps/worker/src/e2e-worker.ts` (free); `mode=live` runs the real
`apps/worker/src/index.ts` against whatever `OPENAI_API_KEY`/
`OPENAI_VISION_MODEL` `.env` already has, refusing to start with no real
key rather than silently falling back to the stub. Confirmed the live
portion's scope and estimated cost with the maintainer via `AskUserQuestion`
before running it, given it makes real, billable calls — the same
consideration P3.5 Task 1's AWS reconciliation needed for a different reason.

**Committed run**: `scripts/concurrency/results/2026-09-18T16-22-43-565Z/`.
Four legs — `stub`/`live` × 1 worker (concurrency 2) / 2 workers (concurrency
1 each), total provider concurrency held at 2 throughout so the worker-count
comparison isolates process-level parallelism from raw concurrency. 25 free
stub scans and 5 real live scans per leg (10 real OpenAI calls total,
**actual cost $0.0298** — even cheaper than the pre-run estimate of
$0.05–0.20, because the synthetic fixture image is visually much simpler
than a real album cover).

| Mode | Workers | Scans | Throughput (scans/min) | providerCall p50 (ms) | Est. cost |
| ---- | ------- | ----- | ---------------------- | --------------------- | --------- |
| stub | 1       | 25/25 | 1498.2                 | 0                     | —         |
| stub | 2       | 25/25 | 1489.0                 | 0                     | —         |
| live | 1       | 5/5   | 27.1                   | 3188                  | $0.0148   |
| live | 2       | 5/5   | 22.8                   | 3103                  | $0.0150   |

**Application time versus provider time, separated as the task requires**:
`storageFetchDurationMs` (reading the normalized image back from object
storage) is 3–12ms in every leg, stub or live — genuinely negligible next to
everything else. `providerCallDurationMs` is 0ms for the stub (by
construction: the synthetic identifier resolves immediately) and 2.2–5.9
seconds for the real run — **provider time is essentially the entire
attempt duration** once a real call is involved; application overhead does
not meaningfully move the total. This real run's provider latency (p50
~3.1s) is substantially faster than P3.5 Task 3's organic real-usage sample
(10–47 seconds) — expected, not a regression: this tool's fixture is one
flat synthetic color square with nothing to describe, while Task 3's numbers
came from real photographed covers, which need more output tokens (and
therefore more generation time) to describe. **Treat this run's latency and
cost as a floor, not a realistic estimate of a real cover's cost** — see the
tool's own README for the same caveat.

**Worker count, holding total concurrency constant**: the stub legs show
essentially no throughput difference between 1 and 2 workers (1498 vs 1489
scans/min — noise, not signal, given provider time is ~0 either way so
almost nothing distinguishes them). The live legs show 1 worker modestly
_outperforming_ 2 workers (27.1 vs 22.8 scans/min) at the same total
concurrency — plausibly the small overhead of two independent BullMQ
consumers and two independent outbox-dispatch polling loops rather than any
real parallelism benefit, but **5 samples per leg is nowhere near enough to
call this a reliable finding**, only a real observation from a real run.
The clearer and more load-bearing result is the application/provider split
above: since provider time dominates total latency by two to three orders of
magnitude over application time, and multiple worker _processes_ did not
demonstrably improve real throughput at fixed total concurrency in this run,
scaling **total provider concurrency** (bounded by whatever OpenAI's rate
limits allow) is the lever worth pursuing before scaling worker replica
count for its own sake — worth a larger, better-powered live run before
treating it as settled, not something this session's 10-scan budget can
prove on its own.

Verified `lint`, `typecheck`, `test` (unchanged — no contract touched),
`format:check` on every changed/new file with `--end-of-line auto`, and
`build`. Left uncommitted for the maintainer's review per this repository's
convention.

## Affected-workspace build/test selection (P3.5 Task 5, 2026-09-18)

New `scripts/affected/` (`npm run test:affected` / `npm run build:affected`,
full method in its own `README.md`) scopes `vitest`/the workspace build to
only the workspaces a change could plausibly break, instead of always running
every workspace. **Tooling decision, recorded before adoption**: a
custom ~250-line script reading each `package.json`'s internal
(`@vinylhound/*`) dependencies and `git diff`, not Nx or Turborepo — this
repository is eleven plain `npm` workspaces with a shallow, easily-enumerated
dependency graph, and adopting a task-graph tool would add a second
build-orchestration layer and its own cache/config surface for a property
(dependency-closure selection plus a conservative fallback) a small,
independently unit-tested script already gets. Revisit if the workspace count
or graph depth grows enough that hand-rolled traversal stops being the
simpler option.

**Mechanism**: resolve a base commit (explicit override, else
`origin/main`, else `HEAD~1`, preferring the merge-base with `HEAD` when
history allows it) using the same approach
`packages/contracts/scripts/check-compatibility.ts` already proved works in
this repo's shallow CI checkouts; list every file that differs from that base
in the working tree (covers committed history since the base plus anything
staged/unstaged/untracked, so local runs reflect real edits); classify each
path as inside a known workspace, inside an explicit safe-ignore list
(`docs/`, `infra/`, `aws/`, `.claude/`, top-level community-health files —
none of which can affect build/test outcomes), or unrecognized.
**Any unrecognized path — root config, a Dockerfile, a CI workflow, a new
top-level directory — forces the existing full `npm test`/`npm run build`
unchanged**; "don't know" always means "run everything," never "assume it's
safe." Otherwise, the directly-changed workspaces are closed over their
transitive dependents (a `packages/contracts` change affects everything that
depends on it, directly or through another package) using a graph rebuilt
fresh from `package.json` on every run, so it cannot go stale. `lint`,
`typecheck`, and `format:check` stay full-repo everywhere: TypeScript compiles
as one project with no project references, so there is no cheaper subset to
select there without a separate, larger restructuring decision.

**Adopted into CI** (`.github/workflows/ci.yml`), not left opt-in-only, per
the roadmap task's own framing (record the decision, then adopt it) and an
explicit maintainer confirmation before wiring the shared gate. `npm run
check` is unbundled into its constituent `format:check`/`lint`/`typecheck`
steps (unchanged, full) plus a new affected-scoped test step; `npm run build`
is replaced by an affected-scoped build step. Both new steps resolve the same
PR-base-or-pushed-over-commit ref the existing contract-compatibility step
already uses, fetch it, and fall back to the full command whenever no base
resolves — the worst case CI can do is exactly what it did before this task.
Local `npm run check`/`npm run build` (the commands `AGENTS.md` documents
running before a handoff) are themselves unchanged; the affected-scoped
commands are additional, CI-oriented tooling, not a replacement for the full
local check.

**Verified correctness**: 13 new unit tests
(`scripts/affected/workspace-graph.test.ts`, `select-affected.test.ts`) cover
graph discovery (including skipping a directory with no `package.json` and
excluding third-party dependencies from internal edges), transitive closure
(a chain, and a diamond dependency reached through two paths, visited once),
and every classification rule (a leaf package, a widely-depended-on package,
ignored documentation/infra paths, a root config file, an unrecognized
top-level path, an unregistered workspace-shaped directory, and combining
several directly-changed workspaces into one closure). Additionally dry-run
against the real repository's dependency graph confirmed the expected
real-world closures: a `packages/queue` change selects
`{queue, worker}`; a `packages/contracts` change selects all eleven
workspaces (contracts sits at the root of the graph); a `docs/`-only change
selects nothing.

**Clean/cached build and test timing, measured before adopting this
optimization so Phase 4 cannot attribute any of it to service extraction**
(this maintainer's development laptop, not a dedicated benchmark machine —
illustrative, not a performance claim; single warm process, three repeats for
test, two to three for build given each clean build's longer wall time):

| Command                                                         | Clean  | Cached (repeat 1) | Cached (repeat 2) |
| --------------------------------------------------------------- | ------ | ----------------- | ----------------- |
| `npm test` (full, 345 tests across 37 files)                    | —      | 3.29s             | 3.57s / 3.82s     |
| `vitest run packages/queue apps/worker` (affected-only)         | —      | 0.87s             | 0.94s / 0.85s     |
| `npm run build` (full: web `next build` + worker + evals `tsc`) | 27.03s | 19.89s            | 21.83s            |
| affected build, worker+evals only (skips web's `next build`)    | 5.18s  | 5.53s             | 5.68s             |

The full test suite is dominated by fixed per-file startup cost across 37
files, not per-test work, so scoping to two affected workspaces (one file
each) is roughly a 4x wall-time reduction for a change that does not touch
`packages/contracts` or anything else widely depended on. The build
difference is larger and structural rather than incremental: `next build`
for `apps/web` accounts for essentially all of the ~20-27s full-build time,
and an affected set that excludes `apps/web` (any change confined to
`packages/queue`, `apps/worker`, or another workspace `apps/web` does not
depend on) skips it entirely rather than running it faster. Neither `tsc`
build here uses incremental mode (plain `tsc --project tsconfig.json`, no
`.tsbuildinfo`), so "clean" and "cached" `tsc` timings are close together by
construction — the affected win for those two is from not invoking `next
build` at all, not from a warm cache. A change that touches
`packages/contracts` (or anything else near the root of the dependency graph)
gets no benefit from this optimization: the affected set is every workspace,
identical to the full command in both scope and — for `vitest`, which does
not batch differently by invocation — wall time.

Verified `lint`, `typecheck`, `test` (345/345, +13 net new — the tool's own
tests, no contract touched), `format:check` on every changed/new file with
`--end-of-line auto`, and `build`. Left uncommitted for the maintainer's
review per this repository's convention.
