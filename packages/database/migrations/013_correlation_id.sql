-- Structured request/error timing and correlation IDs (P3.1): an inbound
-- x-request-id header is validated, optional, and forwarded onto the outbox
-- row and the job payload so the same caller-supplied trace value can be
-- grepped across the HTTP request, the queued job, and the worker attempt it
-- produces. It is untrusted metadata, never identity, so both columns are
-- nullable and carry no foreign key or uniqueness constraint. The bound
-- matches CorrelationIdSchema's max length in packages/contracts.

ALTER TABLE outbox_messages ADD COLUMN correlation_id TEXT;
ALTER TABLE outbox_messages ADD CONSTRAINT outbox_messages_correlation_id_length_check
  CHECK (correlation_id IS NULL OR char_length(correlation_id) BETWEEN 1 AND 200);

ALTER TABLE scan_attempts ADD COLUMN correlation_id TEXT;
ALTER TABLE scan_attempts ADD CONSTRAINT scan_attempts_correlation_id_length_check
  CHECK (correlation_id IS NULL OR char_length(correlation_id) BETWEEN 1 AND 200);
