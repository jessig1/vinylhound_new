# VinylHound repository guide

This file is durable guidance for humans and coding agents working in this repository.

## Start here

Read `README.md`, then the relevant file under `docs/`. Architecture decisions live in `docs/decisions/`; add an ADR when a change affects service boundaries, persistence, public contracts, or providers.

## Multi-agent handoff

OpenAI Codex is the primary implementation agent; Claude is the continuation and review agent (see `CLAUDE.md`). Cross-session state lives in `docs/HANDOFF.md`: read it at session start, and update its current state, resume point, and session log before ending any session that changed files or reached a decision.

## Required task delivery

Follow [docs/AGENT_DELIVERY.md](docs/AGENT_DELIVERY.md) for every task. The
maintainer authorizes agents to create/update task issues, commit task changes,
push task branches, open pull requests when needed to run checks, and inspect
GitHub Actions without requesting confirmation again. A newer task instruction
such as "do not commit" overrides this default for that task.

- **Track manual work.** Create a GitHub issue for each required manual action
  that remains outstanding, including device tests, account configuration,
  deployment rehearsals, and human verification. Search first and update a
  matching issue instead of duplicating it. Include runnable steps, prerequisites,
  acceptance evidence, and the related roadmap task; link it from the handoff.
- **Commit and push each task separately.** Use the exact commit subject
  `p-<phase>.<milestone>.<task>`, for example `p-4.2.3`. Put the change summary,
  verification, and issue references in the commit body. Resolve the task ID
  before committing, stage only that task's changes, and push before handing off.
  Do not leave completed changes uncommitted merely because the latest prompt
  did not repeat "commit and push". Respect branch protection and use a task
  branch/PR; this rule does not authorize merging or bypassing checks.
- **Monitor the pushed commit.** Discover all expected Actions workflows for its
  event/branch and monitor their runs through completion, including downstream
  workflows where applicable. Confirm the exact SHA and latest attempt. A
  successful push, an older green run, missing checks, or pending checks does
  not establish a healthy pipeline. Explain legitimate conditional skips.
- **Track every pipeline failure.** Inspect failing jobs/steps and create an
  actionable GitHub issue, or update the matching open issue, with the commit,
  run/job links, sanitized failure evidence, and the checks needed to verify a
  fix. This applies even to pre-existing failures or failures followed by a
  successful retry. Keep failures visible while addressing in-scope fixes.
- **Report delivery honestly.** Include the task ID, pushed commit/PR, workflow
  outcomes and links, and manual/failure issues in the final handoff. If access,
  a runner, or human approval blocks completion, report the blocker and pending
  work; never describe the pipeline as healthy without verification.

## Commands

- `npm install` — install all workspace dependencies.
- `docker compose up -d` — start local PostgreSQL, Redis, and object storage.
- `npm run dev` — start the web application.
- `npm run dev:worker` — start the background worker skeleton.
- `npm run dev:discovery` — start the standalone discovery service (staging/production only; unused by default local development, which keeps the in-process adapters — ADR-0025).
- `npm run check` — run formatting, linting, type checks, and tests.
- `npm run check:contracts` — prove contract compatibility with the previous deployed version (needs git; CI runs it as its own step).
- `npm run build` — build all implemented workspaces.

## Architectural boundaries

- `apps/web` owns browser UX and HTTP endpoints. It must never contain provider secrets.
- `apps/worker` owns slow, retryable, and batch work.
- `apps/discovery` owns the MusicBrainz/Spotify provider adapters for staging/production (ADR-0025); it is stateless and owns no canonical rows. Development keeps the in-process adapters behind the same ports.
- `packages/contracts` owns schemas crossing process or network boundaries.
- `packages/domain` owns provider- and framework-independent business rules.
- `packages/ai`, `packages/catalog`, `packages/storage`, and `packages/queue` expose ports and provider adapters.
- `packages/service-auth` owns the signed-token mechanism internal services use to assert caller identity and the acting user, together, to each other.
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
