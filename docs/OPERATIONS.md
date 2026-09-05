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
the application, but never signed URLs, credentials, or image bytes. Alert on:

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
monthly limit while token usage is still unknown. The defaults are for local
development; production must deliberately set values aligned with the OpenAI
project's hard monthly limit. The OpenAI project must additionally have its own
spend cap and rate limits, because application controls are defense in depth.

## AWS telemetry and budget

SQS supplies queue depth, age, in-flight, and dead-letter metrics without a
custom polling namespace. Staging scales workers from one to five ECS tasks on
visible queue depth and web from one to three on CPU. Production uses
Kubernetes HPAs for web and worker pods and CloudWatch alarms for SQS age/DLQ;
EKS control-plane logs retain API, audit, and authenticator events. Lambda and
staging logs retain seven days; production logs retain thirty days.

Development has a $10 monthly budget notification and production has $25
thresholds at 40%, 60%, 80%, and 100%. Deployment checks account month-to-date
AWS spend and refuses normal production activation at $20. A production
operator can use the explicit break-glass input only after reviewing active
resources and the requested TTL. Budget data is delayed and is not a hard cap;
the hourly TTL teardown remains the primary cost control.
