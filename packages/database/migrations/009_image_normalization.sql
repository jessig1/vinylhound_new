ALTER TABLE image_assets
  ADD COLUMN analysis_size_bytes bigint,
  ADD COLUMN analysis_width integer,
  ADD COLUMN analysis_height integer,
  ADD COLUMN thumbnail_size_bytes bigint;

ALTER TABLE image_assets
  ADD CONSTRAINT image_assets_analysis_check CHECK (
    (
      completed_at IS NULL
      AND analysis_size_bytes IS NULL
      AND analysis_width IS NULL
      AND analysis_height IS NULL
      AND thumbnail_size_bytes IS NULL
    ) OR (
      completed_at IS NOT NULL
      AND analysis_size_bytes > 0
      AND analysis_width > 0
      AND analysis_height > 0
      AND thumbnail_size_bytes > 0
    )
  );
