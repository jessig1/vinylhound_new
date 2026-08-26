ALTER TABLE scan_confirmations ADD COLUMN reviewed_release JSONB;

UPDATE scan_confirmations AS confirmation
SET reviewed_release = jsonb_build_object(
  'artist', album.artist,
  'title', album.title,
  'releaseYear', release.release_year,
  'label', release.label,
  'catalogNumber', release.catalog_number,
  'barcode', release.barcode
)
FROM releases AS release
JOIN albums AS album ON album.id = release.album_id
WHERE release.id = confirmation.release_id;

ALTER TABLE scan_confirmations
  ALTER COLUMN reviewed_release SET NOT NULL,
  ADD CONSTRAINT scan_confirmations_reviewed_release_check
    CHECK (jsonb_typeof(reviewed_release) = 'object');
