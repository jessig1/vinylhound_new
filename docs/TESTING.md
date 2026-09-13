# Testing and AI evaluations

## Test layers

- Unit: pure domain policy, normalization, state transitions, schema validation.
- Contract: frozen wire fixtures under `packages/contracts/fixtures/` (ADR-0022).
  `npm test` proves the current schemas accept every fixture a deployed
  version sent; `npm run check:contracts` extracts the previous commit's
  contracts from git and proves they accept this tree's event payloads, and
  that no fixture was edited in place. The latter needs git and runs as its
  own CI step.
- Integration: PostgreSQL transactions/outbox, object-storage signing, queue redelivery, OpenAI adapter with recorded/synthetic responses.
- End to end: WCAG 2 A/AA accessibility checks plus mobile and desktop browser
  flows for camera/file inputs, upload progress, refresh recovery, review, and
  library changes.
- AI evaluations: live provider runs against a private labeled image set; not part of every CI run.

CI should never require production secrets or make billable OpenAI calls. Provider integration tests are opt-in and use a dedicated low-budget project.

## Evaluation dataset

Store consented images outside the public repository with a versioned manifest containing:

- case ID and allowed use/retention;
- expected artist/title and any verified edition facts;
- view types (front, back, spine, label, barcode, runout);
- quality tags (glare, crop, blur, handwriting, protective sleeve, low light);
- difficulty/ambiguity notes;
- expected outcome: identify, needs review, or unresolved.

Include common, obscure, reissue, compilation, similarly titled, text-free, damaged, and adversarial/instruction-bearing covers. Split development and holdout sets to avoid tuning directly to every example.

## Metrics and gates

- Rank-1 artist/title exact or normalized match.
- Top-3 recall.
- Precision/recall per edition field, emphasizing false-positive rate.
- Review-routing precision/recall and unresolved correctness.
- Schema success and transient/terminal error rates.
- p50/p95 latency, tokens, and estimated cost.

For local development, a manual smoke test on the same difficult image plus 5-10 known albums is sufficient to validate the initial Sol/prompt-v2 path. Before public rollout or later model, prompt, detail, preprocessing, latency, or cost optimization, record the formal baseline, candidate, dataset version, metric deltas, and accepted tradeoff.

## Current commands

```bash
npm run test
npm run typecheck
npm run lint
npm run check
npm run check:contracts -- --base origin/main
npm run build
npm run test:integration
npm run test:e2e
npm run test:e2e:matrix
npm run eval:ai -- --manifest <private-manifest-path> --dry-run
npm run container:build
terraform -chdir=infra/terraform/bootstrap validate
terraform -chdir=infra/terraform/development validate
terraform -chdir=infra/terraform/environment validate
terraform -chdir=infra/terraform/production validate
```

## Platform and public-repository gates

Pull requests build the web, long-running worker, and Lambda-worker images
without publishing them, create SBOMs, scan the images, validate all four
Terraform roots, and schema-check the Kubernetes manifests with a digest-pinned
kubeconform image. Images must build without application secrets, run as a
non-root user, and support ARM64. Terraform formatting and validation are
secret-free; AWS plans and deployments use repository-scoped GitHub OIDC roles.

Before making the repository public, run Gitleaks against the complete Git
history and manually inspect historical filenames for environment files,
exports, logs, signed URLs, private evaluation artifacts, and user images.
Fork pull requests must pass the ordinary CI and security jobs but cannot
receive repository secrets, GitHub environment secrets, or an AWS role. The
Phase 2 rehearsal records a fork-based run as evidence of this boundary.

Development validation must prove Lambda cold start, EventBridge outbox
publication, SQS partial-batch failure handling, and secret-free Terraform
state. Staging lifecycle validation must prove activation, a forward-only
migration, smoke checks, image promotion, and cleanup. Production rehearsal
additionally proves bounded TTL cleanup, safe SQS drain/reconciliation,
rollback, EKS Pod Identity and HPA behavior, CloudFront/WAF ingress, Aurora cold
resume/restore, and persistence across deactivate/reactivate.

The private live-model harness is documented in `docs/EVALUATION.md`. It validates
consent and maintainer-verified labels before any request, compares configurable
models on identical cases, checkpoints private per-attempt results, and reports
the metrics in this document. Live execution is opt-in and requires
`--confirm-live`; it is never part of CI.

`npm run test:integration` requires the local Compose services. It applies pending
database migrations and exercises PostgreSQL constraints plus a real signed upload
against local MinIO. It also exercises BullMQ against local Redis, including
deterministic-job deduplication and a real consumer. The worker integration suite
uses a synthetic in-process identifier to verify success, review routing,
transient retry, terminal failure, audit persistence, status projection, and
succeeded redelivery without making OpenAI calls. Unit and CI checks remain
secret-free and infrastructure-free.

Unit coverage for the cloud queue adapter verifies strict job parsing, FIFO
message-group/deduplication fields, and SQS source/dead-letter operational
counts. Live SQS, Lambda, ECS, and EKS behavior remains an account-level
rehearsal rather than a secret-bearing CI test.

Unit coverage in `packages/storage` verifies `normalizeImage` bounds a large
source image to the analysis/thumbnail dimension caps and re-encodes to JPEG,
and leaves an already-small image at its original size rather than enlarging
it (ADR-0007).

The database integration suite also verifies reviewed confirmation, idempotent
replay, release normalization, transactional wishlist-to-collection
conversion, batch grouping (idempotent batch creation, scans linked under one
batch, cross-batch isolation, transactional enforcement of the 20-scan server
limit), retrying a failed scan as a new attempt with
idempotent replay of a pending retry, canceling a queued scan so the
outbox dispatcher skips its job without publishing it, and aggregating
token/cost usage across a batch and across an account-wide window (ADR-0008):
a failed attempt with no recorded token usage is excluded from cost totals
but still counted by outcome, and estimated cost matches the per-model
pricing table in `packages/domain`. The worker integration
suite additionally verifies that a scan canceled after being queued is
skipped without a provider call. Database coverage also proves that a scan
completed before migration 009 falls back to its validated original object
when no normalized analysis copy exists.

`npm run test:e2e` is the fast mobile-Chromium gate. It runs Playwright against
a production build served from `.next-e2e` on port 3100; the harness copies the
build's static assets into the standalone output so client components hydrate,
fully isolated from a
running dev server: a dedicated `vinylhound_e2e` database (created and migrated
by the global setup), a dedicated queue name, and a synthetic worker
(`apps/worker/src/e2e-worker.ts`) that exercises the real outbox, queue,
storage, and persistence path without calling OpenAI. It covers grouping
labeled cover photos into independently trackable records, grouping two
front-cover photos into an independently trackable batch (the extracted
capture-session flow on `/scan`, the `/scans/batch/{batchId}` progress page,
and cross-navigation back from a batch item's review page), upload of a
misnamed cover file (content sniffing), identification review, refresh
recovery, confirmation into the collection, the collection listing, and
pre-upload rejection messaging for non-image and HEIC files. The suite also
runs axe-core WCAG 2 A/AA checks against dashboard, scan, collection, wishlist,
and account routes, and verifies a keyboard-visible focus target.

`npm run test:e2e:matrix` runs the same suite in four profiles: mobile Chromium
(Pixel 7), desktop Chromium, desktop Firefox, and mobile WebKit (iPhone 13).
It requires the Docker Compose services and a one-time
`npx playwright install chromium firefox webkit` (Linux/WSL also needs the
browser's OS shared libraries: `sudo npx playwright install-deps` once per
machine).

## Guided automatic capture: real-device protocol

The stubbed-camera Playwright checks prove the browser state machine: a held
frame creates one record, a material frame change rearms it, pausing releases
the track and explicit resume reacquires it, and a permission denial leaves file
upload usable. They do not prove camera autofocus, exposure, or browser media
behavior on a phone.

Before claiming P3.2's device outcome, run this protocol separately on an
iPhone using Safari and an Android phone using Chrome. Use a non-sensitive test
cover and record only sanitized device details and aggregate outcomes.

1. Record device model, OS version, browser version, test date, room/lighting,
   and whether the front cover is matte/glossy or sleeved. Do not record account
   identifiers, photos, signed URLs, or raw image data.
2. Start a new `/scan` session, choose **Use live camera**, and present the
   cover ten times. For each presentation: bring it into the guide, hold until a
   record appears, remove or substantially change the frame until it rearms,
   then present it again. Keep the normal target distance and lighting stable.
3. For each presentation, record capture or miss, elapsed time if notable,
   whether one record (and only one) was added, and any intervention (refocus,
   changed distance, glare adjustment, resume, or manual upload fallback).
4. Background the tab while armed and confirm the camera pauses; return,
   explicitly resume, and repeat one presentation. Deny camera permission once
   (or revoke it in browser settings), then confirm the upload control still
   works.
5. Save a sanitized result table in the private test record. The exit gate is at
   least 9 captures from 10 presentations on each target phone, with zero
   duplicate submissions. A miss is not silently discarded: note the condition
   and intervention used.

Suggested result columns: `device`, `os`, `browser`, `lighting`, `presentation
1..10 outcome`, `capture/miss count`, `duplicate count`, `pause/resume result`,
`fallback result`, and `interventions/notes`.
