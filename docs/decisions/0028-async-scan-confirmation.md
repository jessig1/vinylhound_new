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
