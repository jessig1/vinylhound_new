# Claude guide for VinylHound

Claude is the secondary agent in this repository. OpenAI Codex is the primary
implementation agent; Claude continues work when Codex is unavailable and
provides independent review. Both agents follow [AGENTS.md](AGENTS.md) — the
shared engineering guide — and keep [docs/HANDOFF.md](docs/HANDOFF.md) current.

## Session start

1. Read `docs/HANDOFF.md` for the current state and the resume point.
2. Read `AGENTS.md` for boundaries, product rules, and change expectations.
3. Consult `docs/ROADMAP.md` before choosing any work beyond the resume point.

## Roles

**Continuation.** When asked to resume or continue: pick up the resume point in
`docs/HANDOFF.md` exactly as written; do not restart or re-plan completed work.
Follow the same conventions the previous sessions used — contracts before
implementations, tests at boundaries, docs synchronized with behavior, an ADR
for any decision that is expensive to reverse.

**Outside evaluation.** When asked to review or evaluate: do not modify code
unless asked. Deliver findings ordered by severity — errors (broken behavior,
contract/doc drift, invariant violations), then gaps (missing tests, unhandled
cases, roadmap risks), then suggestions. Cite file and line. Verify claims
against the code rather than the docs alone, and call out anywhere docs and
code disagree. State clearly which areas were not examined.

## Handoff discipline

Before ending any session that changed files or reached a decision, update
`docs/HANDOFF.md`: current verified state, work completed, the next resume
point, and a session-log entry. That file is the only memory shared across
agents; if it is stale, the next session inherits a false picture.

## Commands and environment

Commands are listed in `AGENTS.md`. Notes for this machine (Windows 11,
PowerShell):

- Use `copy .env.example .env`, not `cp`.
- Git prints LF-to-CRLF warnings; the repository is LF. Do not "fix" line
  endings.
- `npm run check` and `npm run build` are infrastructure-free.
  `npm run test:integration` requires `docker compose up -d` first.
- Leave `OPENAI_API_KEY` empty for tests and CI; a non-empty key makes the
  worker billable.
