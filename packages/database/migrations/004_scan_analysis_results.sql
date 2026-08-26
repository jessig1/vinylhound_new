DROP INDEX scan_attempts_scan_id_attempt_number_unique;

ALTER TABLE scan_attempts
  ADD COLUMN delivery_attempt INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN observations JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN needs_review_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN outcome_reason TEXT;

ALTER TABLE scan_attempts
  ADD CONSTRAINT scan_attempts_delivery_attempt_check
    CHECK (delivery_attempt > 0),
  ADD CONSTRAINT scan_attempts_result_arrays_check
    CHECK (
      jsonb_typeof(observations) = 'array'
      AND jsonb_typeof(needs_review_reasons) = 'array'
    ),
  ADD CONSTRAINT scan_attempts_outcome_reason_check
    CHECK (
      outcome_reason IS NULL
      OR outcome_reason IN (
        'no_candidates',
        'provider_review_reason',
        'low_confidence',
        'ambiguous_candidates',
        'high_confidence_clear_lead'
      )
    );

CREATE UNIQUE INDEX scan_attempts_scan_delivery_attempt_unique
  ON scan_attempts (scan_id, attempt_number, delivery_attempt);

CREATE TABLE scan_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_attempt_id UUID NOT NULL REFERENCES scan_attempts(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  release_year INTEGER,
  label TEXT,
  catalog_number TEXT,
  barcode TEXT,
  confidence REAL NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scan_candidates_rank_check CHECK (rank > 0),
  CONSTRAINT scan_candidates_confidence_check CHECK (confidence BETWEEN 0 AND 1),
  CONSTRAINT scan_candidates_artist_title_check
    CHECK (char_length(artist) > 0 AND char_length(title) > 0),
  CONSTRAINT scan_candidates_result_arrays_check
    CHECK (
      jsonb_typeof(evidence) = 'array'
      AND jsonb_typeof(warnings) = 'array'
    )
);

CREATE UNIQUE INDEX scan_candidates_attempt_rank_unique
  ON scan_candidates (scan_attempt_id, rank);
CREATE INDEX scan_candidates_attempt_idx
  ON scan_candidates (scan_attempt_id);
