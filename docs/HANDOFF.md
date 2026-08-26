# Session handoff

Live state shared between the agents working in this repository (OpenAI Codex,
primary; Claude, secondary) and the maintainer. Every agent session that
changes files or reaches a decision must update this file before ending. The
sections above the session log describe current state only; history belongs in
the log.

## How to resume

1. Read "Current state" and "Resume point" below.
2. Verify the claimed state cheaply (`git status`, `npm run check`) before
   building on it.
3. Do the work, update this file, and append a session-log entry.

## Current state — verified 2026-08-26

- Milestone 1 (single-image vertical slice) is functionally complete except
  the private AI eval baseline (`docs/ROADMAP.md`).
- `npm run check` passes: Prettier, ESLint, typecheck, and 22/22 unit tests.
- `npm run build` passes: the Next.js web app (17 routes) and the worker
  compile cleanly.
- Integration tests were not run this session; they require the Docker Compose
  services.
- The vertical slice is committed on `main` (`8c692ed`), followed by the
  upload MIME-sniffing fix. Nothing has been pushed to `origin`.

## Resume point

<!-- The next session starts here. Replace this section when the task
     completes or is re-scoped. -->

**Task:** the last open Milestone 1 item — the small private AI eval baseline
(`docs/OPENAI_INTEGRATION.md` and `docs/TESTING.md` define the gate, metrics,
and dataset shape). It needs consented, labeled cover photos from the
maintainer; the audit trail (model, prompt version, tokens, outcome per
attempt) is already persisted to support it.

Recently completed, for context:

- Upload MIME sniffing fix (client declares content-derived type; HEIC gets a
  pre-upload hint), verified end-to-end. The full capture-to-confirm path is
  confirmed working with a real photo, worker, and OpenAI analysis.
- Phone-sized Playwright e2e suite (`npm run test:e2e`): production build on
  port 3100 from `.next-e2e`, dedicated `vinylhound_e2e` database and queue,
  synthetic worker in `apps/worker/src/e2e-worker.ts` (no OpenAI calls).
  Covers misnamed-file upload, review, refresh recovery, confirmation into
  the collection, and pre-upload rejections. One-time setup:
  `npx playwright install chromium`.

## Known gaps and risks

- No end-to-end browser tests; the completed UI flow is verified manually
  only.
- No AI eval baseline; model or prompt changes are currently unmeasurable.
- Authentication is the single development user. All rows are user-scoped, so
  swapping in real identity issuance later does not change the data model.
- Library `PATCH`/`DELETE` endpoints are documented as planned, not
  implemented (`docs/API.md`).
- Local-only infrastructure; backups and observability are Milestone 4.

## Session log

Newest first. One entry per agent session: date, agent, what changed, what was
decided.

- **2026-08-26 — Claude (fifth session).** Confirmed the full pipeline works
  with real analysis. Built the phone-sized Playwright e2e suite (3 tests,
  passing): isolated production server, e2e database/queue, synthetic worker.
  Updated `docs/TESTING.md` and `docs/ROADMAP.md`; only the AI eval baseline
  remains in Milestone 1. `npm run check` and `npm run build` pass.
- **2026-08-26 — Claude (fourth session).** Investigated a post-fix 422 on
  the same `.webp` file. Proved via database checksums and a live end-to-end
  reproduction (`tmp/diagnose-upload.mjs`) that the server pipeline is
  correct for all WebP variants and the retry ran the stale pre-fix browser
  bundle. Removed the diagnostic scans and objects. No code changed.
- **2026-08-26 — Claude (third session).** Committed the vertical slice
  (`8c692ed`). Fixed the upload rejection: added magic-byte sniffing to
  `packages/contracts` with tests, switched the scan page to declare the
  sniffed MIME type, and noted the client behavior in `docs/API.md`.
  `npm run check` (22 tests) and `npm run build` pass. Nothing pushed.
- **2026-08-26 — Claude (second session).** Recorded the in-flight WebP
  upload-rejection investigation as the resume point, with an independent
  read-only evaluation of the likely cause (extension-derived `File.type`
  versus server magic-byte sniff). No application code changed.
- **2026-08-26 — Claude.** Evaluated project state; verified `npm run check`
  and `npm run build` pass. Created `CLAUDE.md` and this handoff file; linked
  both from `AGENTS.md`. No application code changed.
