# ADR-0016: Use tiered AWS runtimes with SQS as the cloud queue

## Status

Accepted, 2026-09-03. Supersedes ADR-0015's all-ECS/Valkey platform.

## Context

ADR-0015 defined matching just-in-time ECS environments. That design kept the
application simple, but it left no inexpensive always-live portfolio URL and
demonstrated only one compute orchestrator. Its Valkey transport also had to be
drained before teardown because the queue disappeared with the runtime.

The application already isolates job transport behind `ScanQueue`, persists
the authoritative job in a PostgreSQL outbox, and makes scan handling safe to
redeliver. Those boundaries permit different runtimes without splitting the
domain or web/worker processes into new services.

## Decision

Keep local development on Compose, PostgreSQL, MinIO, and BullMQ/Redis. Use
three independently keyed AWS environments:

- Development is always-live and scale-to-zero: API Gateway invokes the
  standalone Next.js image through Lambda Web Adapter; EventBridge publishes
  pending outbox rows once per minute; SQS invokes an analysis Lambda; images
  use private S3; PostgreSQL is an externally managed TLS serverless service.
- Staging remains just-in-time ARM64 ECS Fargate with Aurora Serverless v2,
  private S3, an ALB, and SQS. Every merge deploys, migrates, smoke-tests,
  labels immutable image digests as staging-verified, and tears runtime down.
- Production is a manual, bounded ARM64 EKS demonstration. Terraform retains
  Aurora, S3, SQS, secrets, and control metadata while inactive. Activation
  adds NAT, two managed nodes, the EKS control plane and add-ons, an internal
  ALB, CloudFront VPC origin, WAF, and Kubernetes workloads. Only digests that
  passed staging may be promoted.

SQS FIFO replaces Valkey in every AWS environment. The outbox message ID is
the SQS deduplication ID and the scan ID is its message group. SQS delivery
count remains the auditable attempt number. PostgreSQL state makes duplicate
delivery safe, while a dead-letter queue preserves exhausted messages.
BullMQ remains the local adapter and existing local test transport.

GitHub Actions assumes a distinct OIDC role for development, staging, and
production. Secret values stay in Secrets Manager; workflows inject them into
Lambda or Kubernetes runtime configuration without placing them in Terraform
state. Production uses EKS Pod Identity for separate web and worker roles.

The hourly production cleanup stops web traffic, checks PostgreSQL and SQS for
a drain, deletes Kubernetes workloads, and applies
`environment_active=false`. Manual forced teardown is explicit and retains
SQS/PostgreSQL for later reconciliation.

## Consequences

- The public development URL has no idle container, load balancer, NAT, or
  cache cost, but can cold-start and depends on an external database provider.
- Staging proves the conventional container path; production demonstrates
  Kubernetes, private CloudFront origins, WAF, Pod Identity, and horizontal
  pod scaling. The environments intentionally differ, so promotion proves the
  same application images rather than identical orchestration.
- SQS survives runtime teardown, simplifying recovery, but approximate queue
  metrics replace BullMQ's exact operational counts and FIFO deduplication is
  time-bounded. Database idempotency remains mandatory.
- Production activation takes substantially longer and costs more per hour
  than ECS. The TTL workflow and account-level cost preflight are release
  controls, not optional conveniences.
- The new production Terraform root reuses the existing production state key
  and preserves addresses for retained VPC, Aurora, S3, certificate, secret,
  and SSM resources so activation does not replace stored data or secrets.
