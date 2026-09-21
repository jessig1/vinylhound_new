# ADR-0028: Scan confirmation is a three-hop async pipeline, not one transaction

- Status: Accepted
- Date: 2026-09-19
- Supersedes: [ADR-0005](0005-atomic-scan-confirmation.md)
- Builds on: [ADR-0027](0027-scan-core-schema-ownership.md),
  [ADR-0022](0022-contract-versioning-and-compatibility.md) (event versioning),
  [ADR-0004](0004-transactional-outbox-and-bullmq.md) (outbox, generalized by
  P4.2 Task 2)

## Context

Roadmap P4.2 Task 3
(`docs/roadmap/p4.2-scans-async-confirmation.md`) asks to supersede ADR-0005
at cutover: "one scan transaction stores the reviewed confirmation and
versioned event. A core consumer atomically records an inbox dedupe receipt,
catalog/library changes, and completion event; scan consumes completion into
a projection. No cross-service dual writes."

ADR-0027 (Task 1) already assigned table ownership -- `scan` owns `scans`,
`batches`, `image_assets`, `scan_attempts`, `scan_candidates`,
`scan_confirmations`, `outbox_messages`; `core` owns `users`, `albums`,
`releases`, `catalog_references`, `library_items`, `library_copies`,
`playlists`, `playlist_entries` -- and named `confirmScan`
(`packages/database/src/confirmation-repository.ts`) as the exact transaction
that still crosses the boundary: one PostgreSQL transaction that reads
`scans`/`scan_attempts`/`scan_candidates`, calls `resolveReviewedRelease`
(upserting `albums`/`releases`/`catalog_references`), inserts `library_items`/
`library_copies`, and finally inserts `scan_confirmations`. ADR-0027's own
"Consequences" section named this task's job precisely: "design `core`'s
inbox/completion table inside the `core` schema and stop `confirmScan` from
writing `library_items`/`library_copies` in the same transaction as
`scan_confirmations`."

ADR-0027 also deferred the _physical_ schema/role/process split to Task 7.
This ADR's job is the _logical_ split -- new tables, new versioned events, and
transaction boundaries -- that Task 7 can later cut a literal boundary along,
without moving anything today: one PostgreSQL database, one `apps/worker`
process, exactly as ADR-0027's documented shared failure boundary describes.

## Decision

**Three hops, two new event topics, one new table.**

1. **Hop 1 (scan writes).** `confirmScan` keeps its existing validation
   (advisory lock, reused-idempotency-key check, scan row-lock/status check,
   latest-attempt/candidate check) but no longer calls `resolveReviewedRelease`
   or writes `library_items`/`library_copies`. It inserts a
   `scan_confirmations` row with a new `status` (`pending`/`completed`) =
   `pending`, `release_id`/`library_item_id`/`copy_id` all null, and enqueues
   a `scan.confirmed.v1` event via the existing, already-generalized
   `outbox_messages` table (Task 2 made it topic-aware for exactly this).
   `scan_confirmations.reviewed_release` widens to also carry the submitted
   `list`/`notes`/`copy`, so the row is self-sufficient as both the audit
   record and everything hop 2 needs.

2. **New table `confirmation_receipts`** (logically `core`-owned, physically
   alongside every other table until Task 7). One row per confirmation,
   completed at most once, so it plays both roles ADR-0027 asked for in one
   place: the **inbox dedupe receipt** (a unique `idempotency_key` -- the
   same key from the `scan.confirmed.v1` event -- so a redelivered event does
   not redo the catalog/library write) and the **completion event to
   dispatch** (`payload`/`publish_attempts`/`available_at`/`published_at`/
   `last_error`, claimed the same way `outbox_messages` rows are). Its
   `release_id`/`library_item_id`/`copy_id` are real FKs into `core`'s own
   tables (not application-invariant-only like `outbox_messages.aggregate_id`
   crossing into `scan`), but `library_item_id`/`copy_id` are `set null`, not
   `restrict`: this row is a dedupe/audit record, not a protected reference,
   so removing the library item it named (an ordinary user action, ADR-0018,
   or a whole-account delete) must not be blocked by it.

3. **Hop 2 (core writes).** `processScanConfirmation`
   (`packages/database/src/confirmation-processing-repository.ts`) consumes a
   delivered `scan.confirmed.v1` event in one transaction: check
   `confirmation_receipts` for this event's `idempotency_key` -- if present,
   the event was already processed, do nothing; otherwise call
   `resolveReviewedRelease` and insert `library_items`/`library_copies`
   (moved unchanged from the old `confirmScan`), then insert the
   `confirmation_receipts` row. This is "atomically records an inbox dedupe
   receipt, catalog/library changes, and completion event."

4. **New dispatcher** `dispatchNextConfirmationReceipt`
   (`packages/database/src/confirmation-receipt-repository.ts`) claims and
   delivers `confirmation_receipts` rows, publishing `confirmation.completed.v1`.
   It is a second, simpler function, not a shared generic with
   `dispatchNextOutboxMessage`: that function is multi-topic, does a
   topic-registry contract lookup, and scopes a cancellation check to
   `scan.analyze.v1` specifically -- none of which apply to a single-topic
   table with one caller-supplied publisher and no cancellation concept.

5. **Hop 3 (scan projects).** `applyConfirmationCompletion`
   (`packages/database/src/confirmation-repository.ts`) consumes a delivered
   `confirmation.completed.v1` event: `UPDATE scan_confirmations SET
status='completed', release_id=..., library_item_id=..., copy_id=...,
completed_at=... WHERE scan_id=... AND idempotency_key=... AND
status='pending'` -- idempotent against redelivery. This is "scan consumes
   completion into a projection."

**Two new event contracts** (`packages/contracts/src/confirmation.ts`):
`scan.confirmed.v1` (hop 1 -> 2, reuses `library.ts`'s `ReviewedReleaseShape`)
and `confirmation.completed.v1` (hop 2 -> 3). Both registered in
`EVENT_CONTRACTS`, both with frozen fixtures, following the same
producer-strict/consumer-tolerant split (ADR-0022) every existing topic uses.

**Response contract.** `ScanConfirmationSummarySchema` gains `status` and
`completedAt` as plain optional fields (no default) and `release`/
`libraryItem` become nullable, so a response fixture frozen before this
change -- which has neither key -- still round-trips unchanged.
`AccountExportConfirmationSchema.releaseId` becomes nullable for the same
reason: a pending confirmation has none yet.

**Process boundary stays physical-process-shared, transaction-separated.**
All three hops run inside `apps/worker` today (both the long-running process
and the Lambda), exactly as `scan.analyze.v1` already does -- no new service,
no new deployable. The boundary this ADR draws is which tables each
transaction touches, not which process runs it; that is unchanged from
ADR-0027's own sequencing (physical separation is Task 7's job).

**Queue package generalized, not tripled.** Adding two more topics with the
same BullMQ-pair/SQS-pair shape `scan.analyze.v1` already had made three real
instances of one pattern, so `packages/queue/src/index.ts` factors generic
`createBullMqTopicQueue`/`createBullMqTopicWorker` (+ SQS equivalents); the
existing `scan.analyze.v1` functions become thin wrappers with unchanged
external signatures.

## Consequences

- `docs/ARCHITECTURE.md`'s "Scan and core services" section gains a
  description of the three-hop pipeline.
- The UI (`apps/web/src/app/scans/[scanId]/page.tsx`) extends its existing
  queued/processing poll loop to also poll while `confirmation.status ===
"pending"`, and shows a loading state rather than the "Saved" card until
  `"completed"` -- satisfying this phase's own exit bar ("the UI never
  reports a completed save before the completion projection arrives")
  without building the dedicated "Saving…" UX Task 4 owns.
- **Left to Task 4**: the fuller same-key/different-payload conflict spec,
  safe retry, reconciliation UI, and a possible `confirmation.failed.v1`
  topic. This ADR's replay/conflict handling is the same shape ADR-0005 had
  (idempotency key + request fingerprint comparison), adapted for a `pending`
  state, not a redesign of it.
- **Left to Task 5**: fair/isolated dispatch between the analysis queue and
  the two new confirmation queues. This ADR adds a second, independent, naive
  poll loop (`dispatchNextConfirmationReceipt`) with no latency target and no
  fairness guarantee against the analysis dispatch loop.
- **Left to Task 6**: the `confirmation_receipts.release_id` FK and
  `scan_confirmations.release_id`'s own `restrict` FK are unchanged; a
  pending confirmation whose user is deleted mid-flight will fail hop 2's
  `library_items`/`releases` writes with a foreign-key violation against a
  since-deleted `users` row, producing a stuck, retrying
  `confirmation_receipts`-bound job rather than a clean failure. This is a
  known, documented gap, not solved here -- Task 6 redesigns account deletion
  into a durable, retryable, authenticated workflow specifically because
  late-arriving cross-boundary events like this one must not recreate or
  corrupt deleted account data.
- **Left to Task 7**: no Postgres schema/role split, no separate credentials,
  no physical writer cutover. `confirmation_receipts` and the widened
  `scan_confirmations` stay in the same schema as every other table.

## Amendment (2026-09-20)

Roadmap P4.2 Task 4: specify replay/conflict precisely, and add the
delay/failure/retry/reconciliation this ADR's own "Left to Task 4" note
above named as open.

**Replay/conflict spec (no behavior change -- this formalizes what Task 3
already built and tested).** For a given `(userId, idempotencyKey)`, at any
confirmation status except the ADR-0018 "removed" case (`completed` with a
null `libraryItemId`):

- Same idempotency key, same request fingerprint (`confirmScan`'s
  `hashJson` over every submitted field): idempotent replay. Returns the
  existing row unchanged; no new `outbox_messages` row, no new
  `scan_confirmations` row. Proven by
  `schema.integration.ts`'s "replays a pending confirmation idempotently…"
  test, which also confirms this holds while still `pending`, not only once
  `completed`.
- Same idempotency key, different fingerprint: `409 conflict`. The existing
  row is untouched -- specifically, a still-`pending` row is never mistaken
  for an ADR-0018 "removed" row and deleted, which the same test also
  proves.
- A genuinely new reviewed scan carries its own idempotency key and is
  unaffected by any other confirmation's state.

Duplicate delivery of `scan.confirmed.v1` (redelivery of the same event, at
any hop-2 failure/retry) cannot produce a second physical copy:
`processScanConfirmation`'s `confirmation_receipts_idempotency_key_unique`
constraint guarantees at most one `library_items`/`library_copies` write per
confirmation, proven by the "…writes the library row exactly once, even if
the event is delivered twice" test. This is unchanged by the reconciliation
mechanism below, which is itself just another caller of the same idempotent
function.

**Delay/failure exposure, safe retry, reconciliation (new).** A `pending`
confirmation whose queue delivery permanently fails -- a BullMQ job that
exhausts its 5 default attempts, or an SQS message that dead-letters -- had
no visible failure state and no recovery path before this change; it polled
forever. Two queue-native fixes were considered and rejected: BullMQ does
not re-run a job by re-adding its existing `jobId` (our `idempotencyKey`)
once it already exists in a failed state, only `job.retry()` against that
exact job does; and SQS has no per-message redrive (`StartMessageMoveTask`
moves an entire DLQ, not one message), which does not fit a per-confirmation
user-triggered retry. Both would also mean writing and maintaining separate
BullMQ- and SQS-specific retry code in `packages/queue`.

Instead, `packages/database/src/confirmation-reconciliation-repository.ts`'s
`reconcileScanConfirmation(db, { userId, scanId })` re-drives a stuck
confirmation by calling `processScanConfirmation`/
`applyConfirmationCompletion` directly, off data already durably stored (the
`scan.confirmed.v1` outbox row `confirmScan` wrote, and
`confirmation_receipts`' own stored completion payload) -- the same "queue
is a dumb delivery mechanism, the database is authoritative" position
ADR-0004 and this ADR's own hop design already take. No new event topic
(the "possible `confirmation.failed.v1`" this ADR floated was not needed),
no new schema enum value, no new contract. Idempotent and safe to call any
number of times, including while the normal pipeline is still quietly
working on the same confirmation.

This introduced one real new race the original hop design didn't have:
reconciliation and the normal queue consumer can now both call
`processScanConfirmation` for the same event concurrently, both missing the
not-yet-inserted receipt. Fixed the same way `confirmScan` already guards
its own check-then-act: `processScanConfirmation` takes
`pg_advisory_xact_lock(hashtext('confirmation_receipt'), hashtext(receiptKey))`
as the first statement in its transaction, so two concurrent callers
serialize instead of racing on the unique-constraint insert.
`applyConfirmationCompletion` needed no equivalent -- it is already a single
idempotent `UPDATE ... WHERE status = 'pending'`.

Two entry points call `reconcileScanConfirmation`:

- `POST /api/v1/scans/:scanId/confirm/retry` -- a user-facing manual retry,
  surfaced in `apps/web/src/app/scans/[scanId]/page.tsx` once a pending
  confirmation has been waiting past a 20-second UX threshold (a UI choice,
  not the formal latency target Task 5 owns).
- A new worker poll loop (`apps/worker/src/index.ts`, config
  `CONFIRMATION_RECONCILIATION_POLL_INTERVAL_MS`/`_STALE_AFTER_MS`/
  `_BATCH_SIZE`, defaults 60s / 5 minutes / 50) sweeps confirmations
  `pending` longer than the staleness threshold and reconciles each. Five
  minutes is deliberately longer than the UI's 20-second retry affordance,
  so a user's own click is the first line of recovery and the sweep is the
  safety net for a scan nobody is watching.

The known Task-6 gap this ADR already documented above (a pending
confirmation whose user was deleted mid-flight fails hop 2 with a real
foreign-key violation) is unchanged by this amendment: reconciliation will
retry it too, get the same FK error, and it stays a real, visible failure --
root-causing it is still Task 6's job, not this one's.

## Amendment (2026-09-21): isolated dispatch and a latency target (Task 5)

Roadmap P4.2 Task 5: "Isolate or fairly schedule confirmation dispatch so
analysis cannot starve it. Set a confirmation-to-library latency target
before implementation and include the existing outbox poller's delay in the
measurement."

**The starvation this fixes.** `dispatchNextOutboxMessage` (`outbox-
repository.ts`) claimed the single oldest available `outbox_messages` row
_across every topic registered with it_. `apps/worker`'s one dispatch loop
registered both `scan.analyze.v1` and `scan.confirmed.v1` publishers
together, so the two topics competed for one shared FIFO claim: a deep,
continuously-replenished analysis backlog could keep a newer confirmation
event waiting behind however many older analysis rows preceded it, with no
bound on that wait. This is the "Left to Task 5" gap this ADR's original
"Consequences" section named.

**Decision: isolate, not fairly schedule.** `dispatchNextOutboxMessage` now
scopes its claim query to `Object.keys(publishers)` (an `inArray(topic, ...)`
filter added to the existing `WHERE`), so a call site that registers only one
topic can never claim, lock, or back off a row of another topic. `apps/
worker`'s single combined dispatch loop is split into two independent
loops -- `dispatchAvailableAnalysisJobs` (scan.analyze.v1 only, unchanged
`OUTBOX_POLL_INTERVAL_MS` cadence) and `dispatchAvailableConfirmedEvents`
(scan.confirmed.v1 only, new `CONFIRMATION_DISPATCH_POLL_INTERVAL_MS`
cadence, default 200ms) -- each running its own `WHERE topic = ANY (...)`
query against the same table. `SELECT ... FOR UPDATE SKIP LOCKED` already
lets two such queries run concurrently against one table without contending
for each other's rows, so no schema or migration change was needed. Isolation
was chosen over weighted round-robin fairness because it is strictly
stronger (a starved topic under isolation is impossible, not just less
likely), needed no new claim-ordering logic, and matches the shape this
codebase already established for `confirmation_receipts`
(`dispatchNextConfirmationReceipt`, Task 3): one dispatcher per concern,
independently schedulable.

This also fixed a real, previously undetected bug, not just a missed
optimization: a call site that registered a single-topic publisher registry
still competed for the _globally_ oldest row of any topic under the old
query. On claiming a row outside its own registry, it hit the "no publisher
registered" branch, which is the same code path as a genuine delivery
failure -- it backed the row off under exponential backoff, delaying an
_unrelated_ caller's row for no reason. `schema.integration.ts`'s
`dispatchUntil` helper (scoped to `scan.analyze.v1` only) had been doing
exactly this to other tests' pending `scan.confirmed.v1` rows throughout this
file's suite. The new topic-scoped query makes this impossible: a row outside
a call site's registry is no longer visible to it at all.

`apps/worker/src/lambda.ts`'s `dispatchOutbox` (the scheduled-invocation
path) got the equivalent split: two topic-scoped passes instead of one
combined pass, confirmed events drained first within each invocation.
`apps/worker/src/e2e-worker.ts` got the same split as `index.ts`, so the
browser e2e suite exercises the real isolated shape, not a combined one.

**Confirmation-to-library latency target: p95 ≤ 2000ms, set before this
task's implementation.** "Confirmation-to-library" is measured precisely as
`scan_confirmations.confirmedAt` (hop 1's write, `confirmScan`'s own
transaction) to `confirmation.completed.v1`'s `completedAt` (hop 2's write,
the instant `library_items`/`library_copies` became durable in
`processScanConfirmation`) -- it therefore already includes the hop 1
dispatch pickup delay the roadmap text calls out by name, plus hop 2's own
processing time, and deliberately stops at hop 2 rather than hop 3, since the
library data is already durable at that point regardless of how long the
scan-side projection (hop 3) takes to catch up. Budget, with the isolated
200ms default `CONFIRMATION_DISPATCH_POLL_INTERVAL_MS`:

- Hop 1 -> 2 dispatch pickup: ≤ 200ms worst case, and -- the actual fix --
  bounded independent of `scan.analyze.v1` backlog size, which was not true
  before this task.
- BullMQ enqueue + delivery (local Redis): tens of milliseconds typical.
- `processScanConfirmation`'s transaction (advisory lock, release
  resolution, `library_items`/`library_copies` write, receipt insert):
  tens of milliseconds typical, consistent with this codebase's other
  transactions of similar shape.
- Nominal total: a few hundred milliseconds; 2000ms leaves headroom for
  SQS's higher latency in the SQS-driven deployment and ordinary jitter.

This is a design budget, not a production measurement -- P4.1's live staging
rehearsal (issue #19) has not run yet, so there is no real traffic to sample
p95 from. It is also now directly verifiable, not just estimated:
`applyConfirmationCompletion` (`confirmation-repository.ts`) returns
`{ latencyMs } | null` (null on its existing redelivery/missing-row no-op
paths), computed from the real `confirmedAt`/`completedAt` timestamps with no
new column or migration, and `apps/worker/src/confirmation-completion-
handler.ts` logs it as `confirmationToLibraryLatencyMs` on the existing
`confirmation_completion_applied` line. A real browser e2e run
(`apps/web/e2e/scan-flow.e2e.ts`, mobile-chromium, confirm-and-save test)
measured 165ms end to end through real BullMQ/Postgres -- comfortably inside
budget and consistent with the estimate above.

`confirmation_receipts` -> `confirmation.completed.v1` dispatch (hop 2 -> 3,
`dispatchNextConfirmationReceipt`) moved off `OUTBOX_POLL_INTERVAL_MS` onto
the same new `CONFIRMATION_DISPATCH_POLL_INTERVAL_MS`, since it is part of
the same confirmation-pipeline latency budget, not the analysis one; this
does not change the confirmation-to-library figure itself (which stops at
hop 2) but does lower confirmation-to-_visible_ latency -- how quickly the
UI's poll loop sees `status: "completed"` -- to roughly one more dispatch
cycle beyond the figure above.

**Task 4's thresholds still hold, revisited as the resume point asked.**
Task 4 set a 20-second UI manual-retry threshold and a 5-minute reconciliation
staleness threshold as UX choices, explicitly deferring the formal target to
this task. Both remain appropriate: a confirmation stuck past 20 seconds is
now ~100x this task's own nominal latency, a reliable signal that something
is actually wrong (a dead-lettered job, a stalled worker) rather than
ordinary pipeline latency, and 5 minutes remains a conservative safety-net
window for the unattended sweep. Neither threshold changed.

**Scope boundary: `infra/terraform/development`'s Lambda worker is
unaffected by the latency target.** That root's `aws_cloudwatch_event_rule
"outbox"` triggers `dispatchOutbox` on a `rate(1 minute)` EventBridge
schedule -- a pre-existing, intentionally coarse cadence for that
cost-optimized, non-production tier (staging and production instead run the
long-running `apps/worker/src/index.ts` process against ECS/EKS, per
ADR-0026/P4.1 Task 5, with this task's sub-second dispatch loops). Per
`docs/ROADMAP.md`'s own sequencing note, "additional development service
Lambdas and new hosting platforms are outside this scope," so that
one-minute schedule was left untuned; `dispatchOutbox` still received the
same topic-isolation fix, since the starvation bug it fixes is independent
of invocation cadence.

**Left to Task 6/7, unchanged by this task**: the `confirmation_receipts`/
`scan_confirmations` FK policy, the account-deletion race, and the physical
schema/role/process cutover.

## Amendment (2026-09-21): Task 6 closes the account-deletion race and the release_id FK policy

[ADR-0029](0029-durable-account-deletion-and-release-id-policy.md) resolves
both items this ADR's "Left to Task 6" notes (above, and in the 2026-09-20
amendment) named as open: `scan_confirmations.release_id` and
`confirmation_receipts.release_id` change from `restrict` to `set null`, and
`deleteAccount` becomes a durable drain-then-delete workflow that makes the
foreign-key violation this ADR documented -- a `pending` confirmation whose
user is deleted mid-flight -- no longer reachable, rather than merely
retried more gracefully. See ADR-0029 for the full design. Left to Task 7,
unchanged: the physical schema/role/process cutover.
