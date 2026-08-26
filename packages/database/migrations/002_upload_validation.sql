ALTER TABLE image_assets ADD COLUMN idempotency_key TEXT;
ALTER TABLE image_assets ADD COLUMN width INTEGER;
ALTER TABLE image_assets ADD COLUMN height INTEGER;

UPDATE image_assets SET idempotency_key = id::text;

ALTER TABLE image_assets ALTER COLUMN idempotency_key SET NOT NULL;

ALTER TABLE image_assets
  ADD CONSTRAINT image_assets_idempotency_key_length_check
  CHECK (char_length(idempotency_key) BETWEEN 1 AND 255);

ALTER TABLE image_assets
  ADD CONSTRAINT image_assets_dimensions_check
  CHECK (
    (
      completed_at IS NULL
      AND width IS NULL
      AND height IS NULL
    ) OR (
      completed_at IS NOT NULL
      AND width > 0
      AND height > 0
    )
  );

CREATE UNIQUE INDEX image_assets_scan_id_idempotency_key_unique
  ON image_assets (scan_id, idempotency_key);
