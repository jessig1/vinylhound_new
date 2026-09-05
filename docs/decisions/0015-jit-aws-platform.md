# ADR-0015: Run production-shaped AWS environments just in time

## Status

Superseded by ADR-0016, 2026-09-03.

## Context

VinylHound's MVP already separates a stateless Next.js web process, a retryable
worker, PostgreSQL, Redis, and S3-compatible storage. Phase 2 must demonstrate
professional AWS delivery, scaling, security, recovery, and cost governance,
but this is a portfolio project with a target AWS bill below $20 per month and
no 24/7 availability requirement.

An always-running Fargate service, load balancer, NAT gateway, and managed cache
would exceed that target before meaningful traffic. Replacing the application
with Lambda/SQS would reduce idle compute but would turn the platform phase into
a large application and queue-semantics rewrite.

## Decision

Use Terraform in `us-east-1` and one AWS account with separate staging and
production VPCs and state files. Retain the modular-monolith deployment as two
ARM64 ECS Fargate services. GitHub Actions authenticates through environment-
restricted OIDC roles and deploys immutable ECR digests.

Split each environment into:

- persistent resources: VPC/subnets, Terraform state, ECR, S3 images, Aurora
  PostgreSQL Serverless v2, Secrets Manager, certificate, logs, alarms, and
  budget controls; and
- active resources: NAT, ALB, Route 53 application record, ElastiCache
  Serverless for Valkey, ECS task definitions/services, and autoscaling.

`environment_active=false` removes the active resources without targeted
Terraform operations. Aurora uses a zero-ACU minimum and auto-pauses after ten
idle minutes. Production activation is manual, accepts only an image that
passed staging, defaults to four hours, and cannot exceed eight hours. An
hourly workflow deactivates expired environments.

Before deactivation, the web service stops accepting submissions and an ECS
operations task proves that PostgreSQL has no active scans or pending outbox
rows and Valkey has no waiting, active, or delayed jobs. A separate idempotent
operation republishes database-authoritative queued jobs when Valkey is lost.

## Consequences

- The project demonstrates normal container and managed-service operations
  without paying their hourly floor continuously.
- An inactive demo URL does not resolve, and the first Aurora connection after
  a long idle period can take tens of seconds.
- Cache teardown is safe only after the drain gate passes; emergency recovery
  uses queue reconciliation from persisted outbox records.
- Staging and production share an AWS-account billing and IAM boundary but not
  networking, secrets, data buckets, databases, or Terraform state.
- A future 24/7 SLO requires a new cost model and ADR before raising minimum
  tasks, keeping Valkey/NAT active, adding redundant egress, or adding Aurora
  readers/RDS Proxy.
