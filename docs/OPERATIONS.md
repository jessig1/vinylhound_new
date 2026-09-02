# Operations runbook

## Production topology

Run `apps/web` and `apps/worker` as separate, stateless services. Use managed
PostgreSQL with point-in-time recovery, managed Redis with persistence enabled,
and private S3-compatible object storage with encryption at rest, versioning,
and a lifecycle rule for noncurrent object versions. Do not deploy the local
Compose services or their development credentials to a public environment.

Set `AUTH_MODE=production`, Clerk keys, a non-local `DATABASE_URL`/`REDIS_URL`,
and scoped object-storage credentials only in the web/worker service secret
stores. The web service needs no OpenAI key; only the worker receives it.

The Phase 2 AWS implementation is in `infra/terraform`. Bootstrap owns the
encrypted/versioned Terraform state bucket, immutable ECR repositories, and
GitHub OIDC roles. The environment root owns isolated staging or production
infrastructure. Apply bootstrap once with an administrator identity; all later
plans and applies use GitHub OIDC.

AWS tasks use IAM task roles instead of static S3 credentials. Aurora and
Valkey require TLS; `DATABASE_SSL_MODE=verify-full` and the regional RDS CA
bundle are supplied by Terraform. Database pools default to five connections
per task so autoscaling cannot silently exhaust Aurora connections.

## Just-in-time lifecycle

`environment_active=false` is the normal resting state. It retains the VPC,
image bucket, zero-ACU Aurora cluster, secrets, certificate, logs, alarms, and
state, but removes NAT, ALB, application DNS, Valkey, and ECS services.

- Every merge to `main` builds digest-addressed ARM64 images, activates
  staging runtime without services, migrates, deploys the services,
  smoke-tests, marks the digests staging-verified, and deactivates staging.
- Production is a manual GitHub deployment of a full commit SHA that has
  staging-verified ECR tags. Its TTL is one, two, four, or eight hours.
- An hourly workflow reads the SSM activation/expiry markers and deactivates an
  expired environment.
- Before production deactivation, scale web to zero and run
  `npm run ops:drain-check` as a one-off worker task. Do not remove Valkey until
  the database outbox and queue are drained.
- If Valkey is lost while database scans remain queued, run
  `npm run ops:reconcile-queue`; it checks deterministic job IDs and republishes
  only missing jobs.

Terraform protects Aurora and the image bucket from destruction. Account
decommissioning requires an explicit code review that removes `prevent_destroy`;
normal JIT workflows never do this.

## Deployment and rollback

Terraform first provisions the active runtime and task definition with ECS
services disabled. Migrations then run in a one-off regular Fargate task; only
a successful migration permits the services and autoscaling targets to be
created. Migrations are forward-only and must remain compatible with the
previous application image. ECS deployment circuit breakers roll back failed
services. An operator rollback redeploys the previous ECR digest; it does not
reverse a database migration.

Before the first activation, populate the Clerk secret, Clerk publishable key,
and OpenAI key containers named by Terraform outputs. Never put those values in
Terraform variables or GitHub secrets.

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

The AWS stack provides a low-cardinality `VinylHound` CloudWatch namespace.
Each active worker publishes pending-job count, oldest waiting-job age, and
failed-job count once per minute. ECS scales workers from one to five tasks on
pending work; web tasks scale from one to three on CPU. Basic service metrics
and seven-day staging/thirty-day production logs are the default; Container
Insights stays disabled to avoid an unmeasured telemetry bill.

AWS Budgets sends notifications at $5, $10, $15, and $20. Deployment checks
month-to-date AWS spend and refuses normal activation at $15. A production
operator can use the explicit break-glass input only after reviewing active
resources and expected demo duration. Budget data is delayed and is not a hard
billing cap; TTL teardown remains the primary control.
