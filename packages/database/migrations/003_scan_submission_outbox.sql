ALTER TABLE scans ADD COLUMN submit_idempotency_key TEXT;

ALTER TABLE scans
  ADD CONSTRAINT scans_submit_idempotency_key_length_check
  CHECK (
    submit_idempotency_key IS NULL
    OR char_length(submit_idempotency_key) BETWEEN 1 AND 255
  );

CREATE TABLE outbox_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic TEXT NOT NULL,
  aggregate_id UUID NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  publish_attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT outbox_messages_topic_check
    CHECK (topic = 'scan.analyze.v1'),
  CONSTRAINT outbox_messages_idempotency_key_length_check
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  CONSTRAINT outbox_messages_publish_attempts_check
    CHECK (publish_attempts >= 0),
  CONSTRAINT outbox_messages_attempt_number_check
    CHECK (attempt_number > 0)
);

CREATE UNIQUE INDEX outbox_messages_idempotency_key_unique
  ON outbox_messages (idempotency_key);
CREATE UNIQUE INDEX outbox_messages_topic_aggregate_attempt_unique
  ON outbox_messages (topic, aggregate_id, attempt_number);
CREATE INDEX outbox_messages_pending_idx
  ON outbox_messages (available_at, created_at)
  WHERE published_at IS NULL;
