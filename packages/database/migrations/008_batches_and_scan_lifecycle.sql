ALTER TYPE scan_status ADD VALUE 'canceled';

CREATE TABLE batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT batches_idempotency_key_length_check
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 255)
);

CREATE UNIQUE INDEX batches_user_id_idempotency_key_unique
  ON batches (user_id, idempotency_key);

ALTER TABLE scans
  ADD COLUMN batch_id UUID REFERENCES batches (id) ON DELETE CASCADE;

CREATE INDEX scans_batch_id_idx ON scans (batch_id);
