ALTER TABLE scan.image_assets
  ADD COLUMN crop_provenance jsonb;

ALTER TABLE scan.image_assets
  ADD CONSTRAINT image_assets_crop_provenance_object_check
  CHECK (crop_provenance IS NULL OR jsonb_typeof(crop_provenance) = 'object');

-- Down Migration

ALTER TABLE scan.image_assets
  DROP CONSTRAINT image_assets_crop_provenance_object_check;

ALTER TABLE scan.image_assets
  DROP COLUMN crop_provenance;
