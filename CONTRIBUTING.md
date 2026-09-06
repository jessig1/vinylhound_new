# Contributing to VinylHound

Thanks for helping improve VinylHound. This is an issue-first project: bug
fixes, documentation improvements, and small maintenance changes are welcome
as pull requests, while substantial features should be discussed before code
is written.

## Before you start

Open a GitHub Discussion or issue before changing service boundaries,
persistence, public contracts, identity, providers, infrastructure, or user
data handling. A maintainer will confirm scope and whether an architecture
decision record (ADR) is needed.

Security vulnerabilities must not be filed as public issues. Follow
[SECURITY.md](SECURITY.md) instead.

## Local development

Requirements are Node.js 22 or newer, npm 10 or newer, Docker, and Docker
Compose.

```bash
npm install
copy .env.example .env
docker compose up -d
npm run db:migrate
npm run dev
```

On macOS or Linux, use `cp .env.example .env`. Run the worker separately with
`npm run dev:worker`.

Before opening a pull request, run:

```bash
npm run check
npm run build
```

Run `npm run test:integration` for provider or persistence changes and the
relevant Playwright command for browser-facing changes. Integration and e2e
tests require the local Compose services.

## Engineering expectations

- Follow the dependency boundaries in [AGENTS.md](AGENTS.md) and
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- Update contracts before implementations when data crosses a process or
  network boundary.
- Add unit tests for domain rules and integration tests at provider boundaries.
- Keep database migrations forward-only and update the Drizzle schema in the
  same pull request.
- Add or amend an ADR when a change affects service boundaries, persistence,
  public contracts, identity, or providers.
- Keep documentation synchronized with behavior.
- Preserve idempotency and the image-to-result audit trail.
- Treat AI and catalog output as untrusted candidates.

## Branches, commits, and pull requests

- Branch from `main` and use a short descriptive name such as
  `fix/upload-timeout` or `docs/restore-runbook`.
- Keep a pull request focused on one issue.
- Use a conventional-style pull-request title, for example
  `feat: add queue age alarm` or `fix: preserve signed upload headers`.
- Link the issue or Discussion that established the scope.
- Describe tests, documentation changes, operational impact, and rollback.
- Add screenshots for visible UI changes.
- Expect squash merging; individual commit history does not need to be
  preserved.

## Sensitive and private material

Never commit:

- API keys, credentials, session tokens, or complete signed URLs;
- `.env` files, production logs, database exports, or user identifiers;
- raw production images or unconsented album photos;
- the private AI evaluation manifest, case images, or per-attempt results; or
- copied production data in tests or fixtures.

Use synthetic fixtures and redacted examples. If a secret may have entered Git
history, stop work and report it privately so it can be rotated.

## AI-assisted contributions

AI assistance does not change contributor responsibility. Review every change,
verify licenses and provenance, run the required tests, and describe material
AI assistance in the pull request. Do not send repository secrets, private
evaluation data, or user content to an unapproved model or service.

By contributing, you agree that your contribution is licensed under the
[MIT License](LICENSE).
