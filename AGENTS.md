# VinylHound repository guide

This file is durable guidance for humans and coding agents working in this repository.

## Start here

Read `README.md`, then the relevant file under `docs/`. Architecture decisions live in `docs/decisions/`; add an ADR when a change affects service boundaries, persistence, public contracts, or providers.

## Commands

- `npm install` — install all workspace dependencies.
- `docker compose up -d` — start local PostgreSQL, Redis, and object storage.
- `npm run dev` — start the web application.
- `npm run dev:worker` — start the background worker skeleton.
- `npm run check` — run formatting, linting, type checks, and tests.
- `npm run build` — build all implemented workspaces.

## Architectural boundaries

- `apps/web` owns browser UX and HTTP endpoints. It must never contain provider secrets.
- `apps/worker` owns slow, retryable, and batch work.
- `packages/contracts` owns schemas crossing process or network boundaries.
- `packages/domain` owns provider- and framework-independent business rules.
- `packages/ai`, `packages/storage`, and `packages/queue` expose ports and provider adapters.
- `packages/database` owns migrations and database access once persistence is implemented.

Dependencies should point inward: apps may depend on packages; provider packages may depend on contracts/domain; domain must not depend on apps, databases, queues, or web frameworks.

## Non-negotiable product rules

- Treat AI output as an untrusted candidate, not a verified catalog fact.
- Preserve the original image-to-result audit trail, including model and prompt version.
- Require user review when confidence is low, candidates conflict, or a pressing/edition cannot be established.
- An album-cover match identifies a release concept; it does not by itself prove a specific pressing.
- Make mutating requests idempotent, especially uploads, batch jobs, and collection additions.
- Never send an OpenAI key or unrestricted object-storage credential to the client.
- Use signed, short-lived upload/read URLs and validate MIME type, decoded file type, and size server-side.
- Do not log secrets, full signed URLs, or raw image bytes.

## Change expectations

- Update contracts before implementations when an API or job payload changes.
- Add unit tests for domain rules and integration tests at provider boundaries.
- Add representative, consented images to a private eval dataset rather than the public repository.
- Run `npm run check` before handing off a change. Run `npm run build` for application changes.
- Keep docs synchronized with behavior; record meaningful tradeoffs in an ADR.
