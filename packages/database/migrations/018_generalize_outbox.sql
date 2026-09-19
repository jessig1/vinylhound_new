-- Generalize the outbox for multiple aggregate types and topics (P4.2 Task 2,
-- amending ADR-0004; resolves docs/PHASE_3_4_PLAN_REVIEW.md's G8). The table
-- was hard-wired to scan analysis: `aggregate_id` was a foreign key straight
-- into `scans`, `topic` was pinned to the single literal `scan.analyze.v1`,
-- and `attempt_number` was mandatory with a uniqueness constraint scoped to
-- it. Task 3 needs a second topic -- the reviewed-scan confirmation event --
-- whose aggregate is a confirmation, not a scan, and which has no
-- attempt-number concept at all. Every existing row is a scan analysis
-- message, so it backfills as `aggregate_type = 'scan'` before the column
-- becomes mandatory.

ALTER TABLE outbox_messages ADD COLUMN aggregate_type TEXT NOT NULL DEFAULT 'scan';
ALTER TABLE outbox_messages ALTER COLUMN aggregate_type DROP DEFAULT;
ALTER TABLE outbox_messages
  ADD CONSTRAINT outbox_messages_aggregate_type_length_check
  CHECK (char_length(aggregate_type) BETWEEN 1 AND 63);

-- The FK made every future aggregate type impossible without one physical
-- table per aggregate; existence and ownership become an application
-- invariant enforced by the producer transaction, the same pattern
-- ADR-0027 already documents for the cross-schema FKs it leaves as a
-- temporary exception.
ALTER TABLE outbox_messages DROP CONSTRAINT outbox_messages_aggregate_id_fkey;
CREATE INDEX outbox_messages_aggregate_idx
  ON outbox_messages (aggregate_type, aggregate_id);

-- Replace the single-literal topic CHECK with the general
-- `<aggregate>.<action>.v<N>` shape every topic already satisfies
-- (packages/contracts/src/versioning.ts's EVENT_TOPIC_PATTERN).
ALTER TABLE outbox_messages DROP CONSTRAINT outbox_messages_topic_check;
ALTER TABLE outbox_messages
  ADD CONSTRAINT outbox_messages_topic_format_check
  CHECK (topic ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.v[1-9][0-9]*$');

-- attempt_number is an analysis-specific retry counter; a confirmation event
-- fires once and has none. The (topic, aggregate_id, attempt_number)
-- uniqueness constraint was standing in for a general dedupe key that
-- `idempotency_key` -- already unique, already deterministic per caller --
-- already provides for every topic, analysis included.
DROP INDEX outbox_messages_topic_aggregate_attempt_unique;
ALTER TABLE outbox_messages ALTER COLUMN attempt_number DROP NOT NULL;
ALTER TABLE outbox_messages DROP CONSTRAINT outbox_messages_attempt_number_check;
ALTER TABLE outbox_messages
  ADD CONSTRAINT outbox_messages_attempt_number_check
  CHECK (attempt_number IS NULL OR attempt_number > 0);
