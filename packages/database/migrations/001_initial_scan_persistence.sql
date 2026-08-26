CREATE TYPE ingestion_source AS ENUM (
  'camera',
  'single_upload',
  'batch_upload'
);

CREATE TYPE scan_status AS ENUM (
  'awaiting_upload',
  'queued',
  'processing',
  'identified',
  'needs_review',
  'unresolved',
  'failed'
);

CREATE TYPE image_mime_type AS ENUM (
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
);

CREATE TYPE scan_attempt_status AS ENUM (
  'processing',
  'succeeded',
  'failed'
);

CREATE TYPE provider_error_category AS ENUM (
  'timeout',
  'rate_limit',
  'provider_unavailable',
  'invalid_image',
  'refusal',
  'schema_invalid',
  'unknown'
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source ingestion_source NOT NULL,
  status scan_status NOT NULL DEFAULT 'awaiting_upload',
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CONSTRAINT scans_idempotency_key_length_check
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 255)
);

CREATE UNIQUE INDEX scans_user_id_idempotency_key_unique
  ON scans (user_id, idempotency_key);
CREATE INDEX scans_user_id_status_created_at_idx
  ON scans (user_id, status, created_at);

CREATE TABLE image_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id UUID NOT NULL REFERENCES scans (id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  filename VARCHAR(255) NOT NULL,
  mime_type image_mime_type NOT NULL,
  size_bytes BIGINT NOT NULL,
  checksum_sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT image_assets_object_key_check CHECK (char_length(object_key) > 0),
  CONSTRAINT image_assets_size_bytes_check CHECK (size_bytes > 0),
  CONSTRAINT image_assets_checksum_sha256_check
    CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX image_assets_object_key_unique
  ON image_assets (object_key);
CREATE INDEX image_assets_scan_id_idx ON image_assets (scan_id);

CREATE TABLE scan_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id UUID NOT NULL REFERENCES scans (id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  status scan_attempt_status NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  provider_response_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  duration_ms INTEGER,
  error_category provider_error_category,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT scan_attempts_attempt_number_check CHECK (attempt_number > 0),
  CONSTRAINT scan_attempts_model_check CHECK (char_length(model) > 0),
  CONSTRAINT scan_attempts_prompt_version_check
    CHECK (char_length(prompt_version) > 0),
  CONSTRAINT scan_attempts_token_usage_check CHECK (
    (input_tokens IS NULL OR input_tokens >= 0)
    AND (output_tokens IS NULL OR output_tokens >= 0)
    AND (total_tokens IS NULL OR total_tokens >= 0)
  ),
  CONSTRAINT scan_attempts_terminal_fields_check CHECK (
    (
      status = 'processing'
      AND completed_at IS NULL
      AND duration_ms IS NULL
      AND error_category IS NULL
    ) OR (
      status = 'succeeded'
      AND completed_at IS NOT NULL
      AND duration_ms >= 0
      AND provider_response_id IS NOT NULL
      AND error_category IS NULL
    ) OR (
      status = 'failed'
      AND completed_at IS NOT NULL
      AND duration_ms >= 0
      AND error_category IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX scan_attempts_scan_id_attempt_number_unique
  ON scan_attempts (scan_id, attempt_number);
CREATE INDEX scan_attempts_scan_id_started_at_idx
  ON scan_attempts (scan_id, started_at);
