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

Model or prompt changes should not ship on anecdotal examples. Record the baseline, candidate, dataset version, metric deltas, and accepted tradeoff.

## Current commands

```bash
npm run test
npm run typecheck
npm run lint
npm run check
npm run build
npm run test:integration
```

`npm run test:integration` requires the local Compose services. It applies pending
database migrations and exercises PostgreSQL constraints plus a real signed upload
against local MinIO. It also exercises BullMQ against local Redis, including
deterministic-job deduplication and a real consumer. The worker integration suite
uses a synthetic in-process identifier to verify success, review routing,
transient retry, terminal failure, audit persistence, status projection, and
succeeded redelivery without making OpenAI calls. Unit and CI checks remain
secret-free and infrastructure-free.

The database integration suite also verifies reviewed confirmation, idempotent
replay, release normalization, and transactional wishlist-to-collection
conversion. Phone-sized browser automation for camera/file input, upload
progress, refresh recovery, and form interaction remains the next test layer.
