-- P4.2 Task 3 (ADR-0028, superseding ADR-0005): confirmScan no longer
-- resolves a release or writes library_items/library_copies in the same
-- transaction as scan_confirmations. That work moves to a separate "core"
-- consumer transaction (processScanConfirmation), reached through a new
-- scan.confirmed.v1 outbox event, whose result flows back to scan through a
-- new confirmation.completed.v1 event projected onto scan_confirmations.
--
-- scan_confirmations therefore gains a status: `pending` the instant
-- confirmScan's own transaction commits, `completed` once the projection
-- lands. Every row written before this migration was written synchronously
-- by the old transaction, so every one of them backfills as `completed`.

CREATE TYPE confirmation_status AS ENUM ('pending', 'completed');

ALTER TABLE scan_confirmations
  ADD COLUMN status confirmation_status NOT NULL DEFAULT 'completed';
ALTER TABLE scan_confirmations ALTER COLUMN status DROP DEFAULT;

ALTER TABLE scan_confirmations ADD COLUMN completed_at TIMESTAMPTZ;
UPDATE scan_confirmations SET completed_at = confirmed_at;
-- Stays nullable: a pending row (new confirmations from here on) has no
-- completed_at until the projection lands.

-- Unknown until the core consumer resolves a release for a pending
-- confirmation; still `restrict` once known, per ADR-0011.
ALTER TABLE scan_confirmations ALTER COLUMN release_id DROP NOT NULL;

-- reviewed_release's stored shape widens (list/notes/copy, not just
-- release-identity fields) at the application layer only -- jsonb carries no
-- structural constraint beyond "is an object," unchanged below.

ALTER TABLE scan_confirmations
  ADD CONSTRAINT scan_confirmations_status_consistency_check
  CHECK (
    (status = 'pending'
      AND release_id IS NULL
      AND library_item_id IS NULL
      AND copy_id IS NULL
      AND completed_at IS NULL)
    OR (status = 'completed'
      AND release_id IS NOT NULL
      AND completed_at IS NOT NULL)
  );

-- Logically core-owned (ADR-0027); physically still alongside every other
-- table until Task 7's schema/role cutover. One row per confirmation,
-- completed at most once, so this single table plays both the inbox-dedupe
-- role (the unique idempotency_key) and the completion-event-to-dispatch
-- role (payload/publish_attempts/available_at/published_at/last_error,
-- claimed the same way outbox_messages rows are).
CREATE TABLE confirmation_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Not a foreign key: crosses into scan's ownership (ADR-0027), an
  -- application invariant, the same pattern Task 2 established for
  -- outbox_messages.aggregate_id.
  scan_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT 'confirmation.completed.v1',
  release_id UUID NOT NULL REFERENCES releases(id) ON DELETE RESTRICT,
  -- set null (not restrict): this row is a dedupe/audit record, not a
  -- protected reference, matching scan_confirmations' own pattern. payload
  -- keeps the original id for history even once nulled.
  library_item_id UUID REFERENCES library_items(id) ON DELETE SET NULL,
  copy_id UUID REFERENCES library_copies(id) ON DELETE SET NULL,
  payload JSONB NOT NULL,
  publish_attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  last_error TEXT,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT confirmation_receipts_idempotency_key_length_check
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  CONSTRAINT confirmation_receipts_publish_attempts_check
    CHECK (publish_attempts >= 0)
);

CREATE UNIQUE INDEX confirmation_receipts_idempotency_key_unique
  ON confirmation_receipts (idempotency_key);
CREATE INDEX confirmation_receipts_scan_id_idx ON confirmation_receipts (scan_id);
CREATE INDEX confirmation_receipts_pending_idx
  ON confirmation_receipts (available_at, created_at)
  WHERE published_at IS NULL;
