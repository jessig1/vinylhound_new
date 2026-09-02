# Delivery roadmap

## Phase 1 — MVP (complete)

The original milestones below comprise the completed MVP. Deferred per-copy
editing and the formal private AI evaluation remain explicit limitations, not
Phase 2 platform blockers.

## Milestone 0 — foundation (complete)

- Monorepo, web shell, worker boundary, contracts, domain review policy, AI adapter, local infrastructure, CI, and project documentation.
- Navigable account and library dashboard. The dashboard reads the authenticated
  user's persisted scan, collection, and wishlist data; it no longer uses demo
  activity, fixed counts, or a fixed date.

## Milestone 1 — single-image vertical slice (complete)

- [x] Choose database/migration tool and implement user/scan/image/attempt tables.
- [x] Add development identity, signed upload, server validation, and object-storage adapter.
- [x] Add durable enqueue/outbox and queue worker.
- [x] Call the OpenAI adapter, persist candidates/audit metadata, and poll scan status.
- [x] Build mobile capture/upload, result review/correction, and add-to-list UI.
- [x] Add provider-boundary and confirmation integration tests.
- [x] Add phone-sized end-to-end coverage for the capture-to-confirm path.
- [x] Validate Sol + `high` + prompt v2 manually and accept its artist/title
      quality for the early build. The formal private AI evaluation is deferred
      until public rollout or model/cost optimization.

Exit criterion: one phone photo can become a user-confirmed collection or wishlist item, with retry and failure visibility.

## Milestone 2 — multi-view and batch (complete)

- [x] Group front/back/spine/label images per scan, sent as one labeled
      identification request; preserves the single-image flow and audit trail.
- [x] Multi-select batch setup, independent item progress, cancellation, and
      retry (ADR-0006). Each photo in a batch becomes its own independently
      tracked scan; the `/scan` page gains a "One record" / "Multiple
      records" mode toggle, and `/scans/batch/{batchId}` shows per-item
      status with cancel/retry actions. `/scans` now lists real persisted
      scan history instead of demo data.
- [x] Thumbnail/normalization pipeline (ADR-0007): upload completion derives a
      bounded analysis copy and a UI thumbnail from the validated original;
      scan analysis reads the analysis copy instead of the full-resolution
      original. Worker concurrency limits (`ANALYSIS_CONCURRENCY`, wired into
      BullMQ's `Worker` `concurrency` option) already existed since
      Milestone 1; the roadmap note describing them as missing was stale.
- [x] Batch and provider-cost dashboards: `GET /batches/{batchId}` now
      returns a `cost` summary (tokens and estimated USD) aggregated across
      the batch's member scans, shown on the batch progress page. A new
      `GET /usage` endpoint and `/account/usage` page report account-wide
      scan outcomes and estimated provider spend/token usage over a rolling
      30-day window. Pricing lives in `packages/domain` (moved from the
      private eval package so both share one table).

## Milestone 3 — catalog enrichment and collection quality

- [x] Evaluate catalog sources for canonical IDs, search, deduplication, and
      pressing detail. MusicBrainz is the primary catalog; Discogs is deferred
      as an optional pressing cross-check (ADR-0009 and
      `docs/CATALOG_EVALUATION.md`).
- [x] Add the catalog port/MusicBrainz adapter, richer release metadata, and
      duplicate-copy modeling.
- [x] Direct wishlist-to-owned (and back) conversion without a rescan:
      `PATCH`/`DELETE /library/{itemId}` (ADR-0011), with collection/wishlist
      page actions. Per-copy edit/delete remains explicitly deferred.
- [x] Library search, sort, and CSV export (ADR-0012): `GET /library` accepts
      `q`/`sort` (recent/artist/title), matching and sorting the same
      effective artist/title the page renders; `GET /library/export` returns
      the same filtered/sorted list as a CSV download. Both apply after the
      existing 100-item fetch, so search narrows within that page rather than
      searching beyond it — no pagination was added.

Milestone 3 is complete except per-copy condition/location/notes/acquisition-date
edit and delete (ADR-0010, ADR-0011), which remains explicitly deferred to a
future slice.

## Milestone 4 — public-ready operations

- [x] Production authentication (ADR-0013): Clerk resolves session identity
      in `AUTH_MODE=production`, mapped to a local `users.id` via a new
      `clerk_user_id` column, provisioned just-in-time on first request.
      `AUTH_MODE=development` (the default) keeps today's single fixed user
      with no Clerk dependency, so local dev/CI/tests are unaffected.
- [x] Account export and deletion (ADR-0014): `GET /account/export` returns
      every row a user owns as JSON (metadata only, no image bytes).
      `DELETE /account` performs an ordered hard delete — the user's
      `scan_confirmations` rows first (satisfying their deliberate `restrict`
      FKs, ADR-0011), then the `users` row and its cascades — and
      best-effort deletes the corresponding S3 objects. Shared catalog rows
      (`albums`/`releases`) are never touched. A privacy/retention policy is
      documented in `docs/SECURITY.md`; a user-facing privacy notice is
      still needed.
- [x] Managed-infrastructure operational readiness: the deployment topology,
      managed service requirements, backup retention, and monthly restore drill
      are documented in `docs/OPERATIONS.md`; `npm run ops:restore-test`
      verifies a local logical PostgreSQL backup against an isolated restore
      database. Public health (`/api/healthz`) and database readiness
      (`/api/readyz`) endpoints support service monitoring. Transactional
      per-user daily-analysis, active-scan, and rolling-spend controls reserve
      budget before initial jobs and retries enter the outbox; production must
      configure the related environment limits and provider-side spend cap.
- [x] Accessibility and cross-device browser test matrix: WCAG 2 A/AA checks
      cover the primary authenticated routes, keyboard focus/skip navigation is
      explicit in the shell, and Playwright defines mobile Chromium, desktop
      Chromium, desktop Firefox, and mobile WebKit profiles.

Milestone 2 and Milestone 3 are complete except per-copy edit/delete, which
remains explicitly deferred to a future slice (not currently the next
recommended task — see `docs/HANDOFF.md`'s resume point for what to pick up
next). Keep the formal private AI evaluation as a gate before public rollout
or model/cost optimization.

## Phase 2 — AWS platform engineering and public readiness

Phase 2 promotes the MVP to a secure, cost-bounded public project deployed from
GitHub Actions. Infrastructure code and workflows are implemented in this
repository; AWS/GitHub activation and operational rehearsals require the target
accounts and therefore remain release gates.

### P2.1 — Public repository and contribution foundation

- [x] Add the MIT license, contribution and support guides, code of conduct,
      private security-reporting policy, guided issue forms, pull-request
      template, CODEOWNERS, labels, and release-note configuration.
- [x] Document the project status, limitations, public-history audit, contributor
      workflow, and GitHub repository settings.
- [x] Provide an idempotent GitHub configuration script for Discussions,
      security features, branch protection, merge policy, and labels.
- [x] Rotate the credential found by the 2026-09-02 audit and delete its sole
      containing experimental branch; `main` was never affected.
- [ ] Push the workflows and obtain a clean full-history Gitleaks run, complete
      the visibility-change gate, make the repository public, then apply its
      GitHub settings and branch protection.

### P2.2 — Production runtime and container readiness

- [x] Add pinned, minimal, non-root web and worker images with ARM64 support,
      standalone Next.js output, health checks, and graceful shutdown.
- [x] Remove build-time secret embedding; use ECS task-role credentials by
      default and configurable bounded/TLS database connections.
- [x] Add PR image builds, SBOM generation, and vulnerability gates.
- [ ] Complete the Fargate runtime/shutdown demonstration in the AWS account.

### P2.3 — Terraform foundation and isolated environments

- [x] Add the encrypted/versioned state and ECR bootstrap root with repository-
      scoped GitHub OIDC roles.
- [x] Add independently keyed staging and production environment roots for VPC,
      S3, Aurora Serverless v2, conditional Valkey/ALB/ECS/NAT, DNS/TLS,
      secrets, telemetry, budgets, IAM, and autoscaling.
- [x] Make runtime resources conditional through `environment_active` while
      retaining production data and control-plane resources.
- [ ] Bootstrap and apply the target account after account/domain inputs are set.

### P2.4 — GitHub Actions delivery and just-in-time lifecycle

- [x] Add PR platform checks, immutable ARM image publishing, automatic staging,
      one-off migrations, staged-image promotion, manual bounded production
      activation, hourly expiry cleanup, and safe production drain.
- [x] Add operational drain checking, idempotent queue reconciliation, and cost
      preflight commands.
- [ ] Configure protected GitHub environments and OIDC variables, then complete
      two consecutive staging lifecycle runs.

### P2.5 — Scaling, security, observability, and cost controls

- [x] Encode task isolation, distinct least-privilege roles, worker-only OpenAI
      access, web/worker scaling limits, Spot overflow, log retention, alarms,
      dashboard, SNS, and $5/$10/$15/$20 budget thresholds.
- [x] Refuse normal activation beyond $15 unless a break-glass input is supplied.
- [x] Document the threat model, incident response, backup/restore, and inactive
      cost model.
- [ ] Execute load, failure, authorization, restore, and teardown drills.

### P2.6 — Production rehearsal and completion

- [ ] Rehearse sign-in, signed upload, AI review, collection/export/deletion,
      scaling, Spot replacement, rollback, reconciliation, cold resume/PITR,
      deactivate/reactivate, expiry cleanup, and an untrusted fork PR.
- [ ] Publish sanitized architecture, CI/CD, contribution, cost, threat-model,
      load-test, recovery, and runbook evidence.

Phase 2 completes after two consecutive staging lifecycles, one production
rehearsal, and one fork contribution/security rehearsal pass without manual AWS
console changes.

## Phase 3 — UI/UX polish and AI model training/optimization

Placeholder only. Phase 3 milestones and scope will be planned after Phase 2 is
completed and reviewed.
