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
- `npm run check` passes: Prettier, ESLint, typecheck, and 14/14 unit tests.
- `npm run build` passes: the Next.js web app (17 routes) and the worker
  compile cleanly.
- Integration tests were not run this session; they require the Docker Compose
  services.
- The entire vertical slice is uncommitted: the repository has one commit
  (`65a204e initial commit`) with roughly 3,000 modified lines plus all new
  files untracked. Committing is the safest immediate action before any
  further change.

## Resume point

<!-- The next session starts here. Replace this section when the task
     completes or is re-scoped. -->

**Task:** debug and fix an upload-validation rejection. Trying to identify an
album failed with the user-visible error "The decoded file type does not match
the declared image type." After the fix, run the checks and commit the entire
vertical slice (the maintainer's stated intent: "finish, then commit").

**Progress so far (Codex session, 2026-08-26):** traced the declared MIME
through the browser upload and server decoder. The failed upload is a `.webp`
file declared as `image/webp`; the validator deleted the rejected object as
designed. Next step in flight: check the original local file's signature to
determine whether the browser supplied a misleading MIME type or the detector
mishandles a valid WebP variant.

**Outside evaluation (Claude, 2026-08-26), to verify rather than trust:**

- The error originates at `packages/storage/src/image-validation.ts` line 60,
  where `fileTypeFromBuffer` (magic-byte sniff) disagrees with the declared
  type. The SHA-256 checksum check passes _before_ that line, so the stored
  bytes are byte-identical to the file the browser hashed — the local file
  itself, not transit or storage, carries non-WebP bytes.
- The client declares `mimeType: file.type`
  (`apps/web/src/app/scan/page.tsx` line 104), and browsers derive
  `File.type` from the filename extension, not content. A JPEG/PNG/HEIC file
  renamed or saved as `.webp` (common with images saved from
  content-negotiating CDNs) reproduces this exactly. `file-type` detects all
  WebP variants (VP8/VP8L/VP8X) by RIFF signature, so a genuine WebP passing
  checksum but failing the sniff is unlikely.
- Suggested fix shape, if the diagnosis holds: sniff the first bytes
  client-side and declare the sniffed type instead of `file.type`, keeping the
  server rule (reject declared-vs-decoded disagreement, `docs/API.md`)
  unchanged. If the bytes are a type outside the accepted set (for example
  HEIC from an iPhone), tell the user immediately before uploading instead of
  surfacing the server rejection. Add a regression test either way.

**After that**, the roadmap's declared next steps are:

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

- **2026-08-26 — Claude (second session).** Recorded the in-flight WebP
  upload-rejection investigation as the resume point, with an independent
  read-only evaluation of the likely cause (extension-derived `File.type`
  versus server magic-byte sniff). No application code changed.
- **2026-08-26 — Claude.** Evaluated project state; verified `npm run check`
  and `npm run build` pass. Created `CLAUDE.md` and this handoff file; linked
  both from `AGENTS.md`. No application code changed.
