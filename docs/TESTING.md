# Testing and AI evaluations

## Test layers

- Unit: pure domain policy, normalization, state transitions, schema validation.
- Contract: fixtures for HTTP/job schemas and backwards compatibility.
- Integration: PostgreSQL transactions/outbox, object-storage signing, queue redelivery, OpenAI adapter with recorded/synthetic responses.
- End to end: phone-sized browser flows for camera/file inputs, upload progress, refresh recovery, review, and library changes.
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
npm run build
npm run test:integration
npm run test:e2e
npm run eval:ai -- --manifest <private-manifest-path> --dry-run
```

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

Unit coverage in `packages/storage` verifies `normalizeImage` bounds a large
source image to the analysis/thumbnail dimension caps and re-encodes to JPEG,
and leaves an already-small image at its original size rather than enlarging
it (ADR-0007).

The database integration suite also verifies reviewed confirmation, idempotent
replay, release normalization, transactional wishlist-to-collection
conversion, batch grouping (idempotent batch creation, scans linked under one
batch, cross-batch isolation), retrying a failed scan as a new attempt with
idempotent replay of a pending retry, and canceling a queued scan so the
outbox dispatcher skips its job without publishing it. The worker integration
suite additionally verifies that a scan canceled after being queued is
skipped without a provider call.

`npm run test:e2e` runs Playwright at a phone viewport against a production
build served from `.next-e2e` on port 3100, fully isolated from a running dev
server: a dedicated `vinylhound_e2e` database (created and migrated by the
global setup), a dedicated queue name, and a synthetic worker
(`apps/worker/src/e2e-worker.ts`) that exercises the real outbox, queue,
storage, and persistence path without calling OpenAI. It covers grouping
labeled front/back/spine photos into one multi-view scan, grouping two
front-cover photos into an independently trackable batch (mode toggle on
`/scan`, parallel per-item upload, the `/scans/batch/{batchId}` progress page,
and cross-navigation back from a batch item's review page), upload of a
misnamed cover file (content sniffing), identification review, refresh
recovery, confirmation into the collection, the collection listing, and
pre-upload rejection messaging for non-image and HEIC files. It requires the
Docker Compose services and a one-time `npx playwright install chromium`
(Linux/WSL also needs the browser's OS shared libraries: `sudo npx playwright
install-deps` once per machine).
