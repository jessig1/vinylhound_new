CREATE TYPE image_view_type AS ENUM (
  'front',
  'back',
  'spine',
  'label',
  'barcode',
  'runout',
  'other'
);

ALTER TABLE image_assets
  ADD COLUMN view_type image_view_type NOT NULL DEFAULT 'front';

ALTER TABLE image_assets
  ALTER COLUMN view_type DROP DEFAULT;

CREATE INDEX image_assets_scan_id_view_type_idx
  ON image_assets (scan_id, view_type);
