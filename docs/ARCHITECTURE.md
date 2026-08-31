# Architecture

## Decision summary

VinylHound starts as a modular monolith with two processes: a Next.js web application and a Node.js background worker. PostgreSQL is the source of truth, Redis backs retryable jobs, and S3-compatible storage holds images. Shared TypeScript packages keep provider and domain boundaries explicit.

```mermaid
flowchart LR
  Phone[Phone camera or uploads] --> Web[Next.js web app]
  Web -->|signed upload| Objects[(Object storage)]
  Web -->|scan + transactional outbox| DB[(PostgreSQL)]
  DB -->|outbox publisher| Queue[(Redis queue)]
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
PostgreSQL transaction. The worker publishes pending messages to BullMQ using a
deterministic job ID and only then marks them published. A crash between those
steps causes a safe duplicate publication attempt instead of a lost scan.

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
