# Architecture

## Decision summary

VinylHound is a modular monolith with two processes: a Next.js web application
and a Node.js background worker. PostgreSQL is the source of truth, a durable
queue transports retryable jobs, and S3-compatible storage holds images.
BullMQ/Redis is the local queue adapter; AWS environments use SQS. Shared
TypeScript packages keep provider and domain boundaries explicit.

```mermaid
flowchart LR
  Phone[Phone camera or uploads] --> Web[Next.js web app]
  Web -->|signed upload| Objects[(Object storage)]
  Web -->|scan + transactional outbox| DB[(PostgreSQL)]
  DB -->|outbox publisher| Queue[(BullMQ or SQS)]
  Queue --> Worker[Background worker]
  Worker -->|validated object read| Objects
  Worker -->|request-scoped image data + schema| OpenAI[OpenAI Responses API]
  Worker -->|candidates + audit metadata| DB
  DB --> Review[User review]
  Review --> Lists[Collection or wishlist]
```

## Why asynchronous scans

Camera uploads and batch analysis are slower and less reliable than normal HTTP requests. The web request should finish after durable scan creation and job enqueueing. The worker can then retry transient provider failures, enforce concurrency/rate limits, and update item-level progress without tying work to a browser connection.

## Core flow

1. Web creates a scan in `awaiting_upload` and returns signed upload instructions.
2. Browser uploads directly to object storage and reports completed image metadata/checksums.
3. Web validates ownership/completeness, atomically marks the scan `queued`, and publishes an idempotent job.
4. Worker claims the job, marks it `processing`, reads the authoritative validated objects, creates request-scoped Base64 data URLs, and calls the AI adapter.
5. Structured output is validated. Domain policy independently determines whether the result can be presented as identified or needs review.
6. User confirmation creates or selects a canonical release and adds or converts
   a library item in one transaction. If the user owns it, the same transaction
   creates a physical-copy row. A user-triggered MusicBrainz search may attach
   namespaced release-group/release references and richer reviewed metadata;
   catalog output remains a candidate. The confirmation retains the selected AI
   candidate, reviewed corrections, catalog provenance, and originating scan.

Submission writes the `queued` scan state and a versioned outbox message in one
PostgreSQL transaction. The worker publishes pending messages through the queue
port using a deterministic idempotency key and only then marks them published.
A crash between those steps causes a safe duplicate publication attempt instead
of a lost scan. BullMQ uses that key as its job ID; SQS FIFO uses it as the
deduplication ID and the scan ID as the message group.

## Boundaries

- Browser: capture, preview, client-side UX checks, direct upload, progress. No secrets and no authoritative validation.
- Web/API: authentication, authorization, signed URLs, commands, queries, idempotency, and orchestration.
- Worker: retries, provider calls, concurrency controls, scan attempts, and terminal failure handling.
- Domain: review policy, legal status transitions, duplicate rules, and library invariants.
- Providers: OpenAI, MusicBrainz catalog, queue, and storage behind interfaces.

## Deployment evolution

For personal use, web and worker can run on one host with one PostgreSQL/Redis deployment. Scale in this order only when measurements justify it:

1. Move images to managed object storage and database backups to managed PostgreSQL.
2. Scale workers horizontally with global provider concurrency limits.
3. Add read replicas/caching for large collection queries.
4. Split a service only when it needs independent ownership, deployment, or scaling; package boundaries are the extraction seams.

## Reliability and observability

- Every scan, upload, job, provider attempt, and user command gets a stable ID.
- Use structured logs with IDs and durations, never image bytes or secrets.
- Record model, prompt version, image count, status, latency, token usage, and normalized error category.
- Retry timeouts, rate limits, and provider 5xx responses with exponential backoff and jitter. Do not retry invalid inputs or schema failures indefinitely.
- Jobs must be idempotent and safe to redeliver. Terminal failures remain visible and manually retryable.
- `GET /api/healthz` is a process liveness probe and `GET /api/readyz`
  verifies PostgreSQL readiness without exposing dependency details. The
  operational alerting, backup, and restore procedure is in
  `docs/OPERATIONS.md`.
- Before a scan job enters the outbox, a per-user transactional quota check
  enforces daily analysis volume, active scans, and rolling spend. Active jobs
  reserve a configured cost while their actual token usage is unknown, so
  concurrent submissions cannot evade a monthly budget.

## Authentication

All persisted user-owned rows and object keys include a user identifier
(`users.id`, an internal UUID unrelated to any external identity provider),
established in the first vertical slice. `AUTH_MODE` selects how that ID is
resolved per request (ADR-0013):

- `development` (default): every request uses a single fixed
  `DEVELOPMENT_USER_ID`. No external identity provider is involved; local
  dev, CI, and integration tests run this way with no auth-provider keys.
- `production`: Clerk issues and verifies the session; `apps/web/src/proxy.ts`
  (Next.js's Proxy/Middleware convention) protects routes, and
  `requireUserId` (`apps/web/src/server/auth.ts`) resolves the verified
  Clerk identity to a local `users.id`, provisioning a row just-in-time on
  first request via `users.clerk_user_id`.

Introducing `production` mode changed identity issuance and session
verification only, not the data model — every foreign key still points at
`users.id` exactly as before.

## Phase 2 AWS deployment

ADR-0016 preserves the web/worker boundary while deliberately exercising three
runtime shapes. GitHub Actions uses environment-scoped OIDC roles and immutable
ECR digests. Staging verifies the same web and long-running worker images that
production promotes; development uses the web image plus a Lambda-specific
worker entrypoint.

```mermaid
flowchart TB
  GitHub[GitHub Actions OIDC] --> ECR[(Immutable ECR images)]
  GitHub --> Terraform[Four Terraform roots]
  ECR --> Dev[Development: API Gateway + Lambda]
  ECR --> Stage[Staging: ALB + ECS Fargate]
  ECR --> Prod[Production: CloudFront/WAF + private ALB + EKS]
  Dev --> DevData[(External PostgreSQL + dev SQS/S3)]
  Stage --> StageData[(Staging Aurora + SQS/S3)]
  Prod --> ProdData[(Production Aurora + SQS/S3)]
```

Development has no VPC or idle worker: API Gateway and SQS invoke Lambdas, and
EventBridge periodically publishes committed outbox rows. Staging web and
worker tasks run in private subnets on Fargate. Production pods run on two ARM64
managed EKS nodes with separate Pod Identity roles; CloudFront reaches the
internal ALB through a VPC origin. Staging and production create a single NAT
only while active for Clerk, MusicBrainz, and OpenAI egress, while an S3 gateway
endpoint keeps object traffic private.

The environment differences, persistent/active resource split, scaling limits,
and deactivation gate are defined in ADR-0016 and `docs/OPERATIONS.md`.
