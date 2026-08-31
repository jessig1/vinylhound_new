CREATE TYPE catalog_provider AS ENUM ('musicbrainz');
CREATE TYPE catalog_entity_type AS ENUM ('album', 'release');
CREATE TYPE record_condition AS ENUM (
  'mint',
  'near_mint',
  'very_good_plus',
  'very_good',
  'good_plus',
  'good',
  'fair',
  'poor'
);

ALTER TABLE releases
  ADD COLUMN release_date VARCHAR(10),
  ADD COLUMN country VARCHAR(10),
  ADD COLUMN format VARCHAR(255),
  ADD COLUMN packaging VARCHAR(255),
  ADD COLUMN release_status VARCHAR(100);

CREATE TABLE catalog_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider catalog_provider NOT NULL,
  entity_type catalog_entity_type NOT NULL,
  external_id VARCHAR(255) NOT NULL,
  album_id UUID REFERENCES albums(id) ON DELETE CASCADE,
  release_id UUID REFERENCES releases(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT catalog_references_owner_check CHECK (
    (entity_type = 'album' AND album_id IS NOT NULL AND release_id IS NULL)
    OR (entity_type = 'release' AND release_id IS NOT NULL AND album_id IS NULL)
  )
);

CREATE UNIQUE INDEX catalog_references_external_identity_unique
  ON catalog_references (provider, entity_type, external_id);
CREATE INDEX catalog_references_album_id_idx ON catalog_references (album_id);
CREATE INDEX catalog_references_release_id_idx ON catalog_references (release_id);

CREATE TABLE library_copies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  library_item_id UUID NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  release_id UUID NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  confirmed_from_scan_id UUID REFERENCES scans(id) ON DELETE SET NULL,
  media_condition record_condition,
  sleeve_condition record_condition,
  location VARCHAR(255),
  notes TEXT,
  acquired_at DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT library_copies_notes_length_check
    CHECK (notes IS NULL OR char_length(notes) <= 2000)
);

CREATE INDEX library_copies_library_item_created_idx
  ON library_copies (library_item_id, created_at);
CREATE INDEX library_copies_release_id_idx ON library_copies (release_id);

INSERT INTO library_copies (user_id, library_item_id, release_id, confirmed_from_scan_id)
SELECT user_id, id, release_id, confirmed_from_scan_id
FROM library_items
WHERE list = 'collection';

ALTER TABLE scan_confirmations
  ADD COLUMN copy_id UUID REFERENCES library_copies(id) ON DELETE SET NULL;

UPDATE scan_confirmations AS confirmation
SET copy_id = copy.id
FROM library_copies AS copy
WHERE copy.library_item_id = confirmation.library_item_id
  AND copy.confirmed_from_scan_id = confirmation.scan_id;

UPDATE scan_confirmations
SET reviewed_release = reviewed_release || jsonb_build_object(
  'releaseDate', NULL,
  'country', NULL,
  'format', NULL,
  'packaging', NULL,
  'releaseStatus', NULL,
  'catalogReference', NULL
);
