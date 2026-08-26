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

**Task:** none in flight. The upload-rejection bug ("The decoded file type
does not match the declared image type") is fixed and committed: the client
now derives the declared MIME type from magic bytes via `detectImageMimeType`
in `packages/contracts/src/upload.ts` instead of the extension-based
`File.type`, with unit tests in `packages/contracts/src/upload.test.ts`.
HEIC/HEIF files are rejected client-side with a conversion hint before any
upload. Server-side validation is unchanged and remains authoritative.

The fix is verified against the live pipeline: genuine WebP variants (VP8,
VP8L, VP8X) pass end-to-end, and JPEG bytes declared as `image/webp`
reproduce the original 422 exactly. A post-fix retry of the original file
still failed only because the browser ran the pre-fix bundle — it declared
`image/webp` for byte-identical non-WebP content, which only the old
`File.type` code path does. Remedy: restart `npm run dev` and hard-refresh
before retrying. The diagnostic script is kept at `tmp/diagnose-upload.mjs`
(gitignored).

**Next**, the roadmap's declared next steps are:

1. End-to-end phone-browser coverage for the capture-to-confirm path
   (`docs/TESTING.md` names this the next test layer).
2. A small private AI eval baseline (`docs/OPENAI_INTEGRATION.md` and
   `docs/TESTING.md` define the gate, metrics, and dataset shape).

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
