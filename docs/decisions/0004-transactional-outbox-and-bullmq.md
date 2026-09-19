# ADR-0004: Transactional outbox with BullMQ

- Status: Accepted
- Date: 2026-08-25

## Context

Submitting a scan changes durable PostgreSQL state and schedules asynchronous
work in Redis. Writing those systems independently creates a failure window: a
committed `queued` scan could be left without a job, or a retry could create
duplicate jobs and duplicate provider spend.

## Decision

Scan submission writes the scan state and a versioned `scan.analyze.v1` outbox
message in one PostgreSQL transaction. The background process polls pending rows,
publishes them to BullMQ, and then records publication. Publication retries use a
deterministic `scan-{scanId}-attempt-{attemptNumber}` BullMQ job ID.

The queue package validates payloads at enqueue and consumption boundaries.
BullMQ retains completed and failed jobs for bounded periods so a publication
retry can resolve to the existing job. Consumer handlers must still be
idempotent and consult authoritative attempt state before calling a paid provider.

## Consequences

- A Redis outage delays publication without losing the accepted scan.
- A crash after Redis accepts a job can cause redelivery, but the stable job ID
  prevents another live job for that attempt while the retained job exists.
- Pollers use row locks with `SKIP LOCKED`, allowing safe horizontal publisher
  concurrency. The initial implementation holds that short row transaction open
  during Redis publication; a lease-based claim can replace it if measurements
  show lock duration is material.
- PostgreSQL remains the source of truth, while Redis is a retryable delivery
  mechanism with at-least-once failure semantics.

## Amendment (2026-09-03)

ADR-0016 adds SQS as the AWS queue adapter while retaining BullMQ locally. The
transactional outbox, deterministic idempotency key, schema validation, and
database-authoritative consumer rules remain unchanged. SQS FIFO maps the key
to `MessageDeduplicationId` and the scan ID to `MessageGroupId`; its retained
DLQ replaces BullMQ's failed-job set in cloud environments.

## Amendment (2026-09-19)

Roadmap P4.2 Task 2 generalizes `outbox_messages` beyond scan analysis, ahead
of Task 3's confirmation event, resolving the four scan-only constraints
`docs/PHASE_3_4_PLAN_REVIEW.md`'s G8 named (migration
`packages/database/migrations/018_generalize_outbox.sql`; ADR-0027 already
scoped this table to the `scan` schema and flagged Task 2 as the task that
would change its shape):

1. `aggregate_id` is no longer a foreign key into `scans`. A row now also
   carries `aggregate_type`; existence and ownership of the aggregate a row
   names are an application invariant enforced by the producer transaction,
   not a database constraint — the same pattern ADR-0027 already applies to
   the cross-schema FKs it leaves as a temporary exception.
2. `topic` is no longer pinned to the single literal `scan.analyze.v1`. A
   `CHECK` instead enforces the general `<aggregate>.<action>.v<N>` shape
   `packages/contracts/src/versioning.ts`'s `EVENT_TOPIC_PATTERN` already
   requires of every topic.
3. `attempt_number` is nullable. It remains an analysis-specific retry
   counter that `scan.analyze.v1` rows still populate; a topic with no
   attempt concept (a confirmation event, which fires once) omits it. The
   `(topic, aggregate_id, attempt_number)` uniqueness constraint that stood
   in as this table's dedupe key is dropped in favor of the `idempotency_key`
   uniqueness every topic already provides.
4. The dispatcher (`packages/database/src/outbox-repository.ts`, moved out of
   `scan-repository.ts`) claims the oldest available row regardless of topic
   and looks up a publisher from a topic-keyed registry the caller supplies,
   parsing the stored payload through that topic's registered
   `EventContract` consumer schema (ADR-0022) when one is registered. Row
   locking with `SELECT ... FOR UPDATE SKIP LOCKED`, exponential backoff on
   publish failure, and the row lock held across the publish call are
   unchanged. The cancellation skip (a `canceled` scan's job is marked
   published without being delivered) is scoped to the `scan.analyze.v1`
   topic specifically, since it is the only topic whose aggregate can be
   canceled between submit and dispatch; other topics are never looked up
   against `scans`.

No consumer behavior changes for `scan.analyze.v1`: the worker's publisher
registry still enqueues to BullMQ/SQS exactly as before. This amendment only
removes constraints that were specific to analysis jobs and adds the
dispatch-time indirection Task 3's confirmation topic needs; it introduces no
second topic itself.
