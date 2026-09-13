# VinylHound repository guide

This file is durable guidance for humans and coding agents working in this repository.

## Start here

Read `README.md`, then the relevant file under `docs/`. Architecture decisions live in `docs/decisions/`; add an ADR when a change affects service boundaries, persistence, public contracts, or providers.

## Multi-agent handoff

OpenAI Codex is the primary implementation agent; Claude is the continuation and review agent (see `CLAUDE.md`). Cross-session state lives in `docs/HANDOFF.md`: read it at session start, and update its current state, resume point, and session log before ending any session that changed files or reached a decision.

## Commands

- `npm install` — install all workspace dependencies.
- `docker compose up -d` — start local PostgreSQL, Redis, and object storage.
- `npm run dev` — start the web application.
- `npm run dev:worker` — start the background worker skeleton.
- `npm run check` — run formatting, linting, type checks, and tests.
- `npm run check:contracts` — prove contract compatibility with the previous deployed version (needs git; CI runs it as its own step).
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

## Import conventions

Relative imports inside `packages/**` and `apps/worker/**` name the TypeScript
file they resolve to — `import { x } from "./catalog.ts"`, not `./catalog.js`.
Bundlers resolve that literally (Turbopack has no equivalent of webpack's
`resolve.extensionAlias`), and `rewriteRelativeImportExtensions` rewrites it
back to `./catalog.js` when `tsc` emits the worker's Node ESM output. A `.js`
specifier will fail to resolve in `apps/web`. See ADR-0020.

## Change expectations

- Update contracts before implementations when an API or job payload changes.
- When a contract changes, add a fixture under `packages/contracts/fixtures/` (freeze the shape the previous version sent if none exists; add the new one) and never edit an existing fixture in place. Events are versioned by topic (`<aggregate>.<action>.v<N>`) and read with their tolerant `consumerSchema`; anything a consumer must not lose is a new topic version. Browser code reads a response with `parseResponse(schema, json)`, never `XResponseSchema.parse`, so an open tab survives an added field; the server keeps validating what it emits with the strict schema. See ADR-0022 and `docs/API.md`.
- Add unit tests for domain rules and integration tests at provider boundaries.
- Add representative, consented images to a private eval dataset rather than the public repository.
- Run `npm run check` before handing off a change. Run `npm run build` for application changes.
- Keep docs synchronized with behavior; record meaningful tradeoffs in an ADR.
