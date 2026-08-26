CREATE TYPE library_list AS ENUM ('collection', 'wishlist');

CREATE TABLE albums (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artist VARCHAR(255) NOT NULL,
  title VARCHAR(255) NOT NULL,
  normalized_artist VARCHAR(255) NOT NULL,
  normalized_title VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX albums_normalized_identity_unique
  ON albums (normalized_artist, normalized_title);

CREATE TABLE releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  album_id UUID NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  identity_key CHAR(64) NOT NULL,
  release_year INTEGER,
  label VARCHAR(255),
  catalog_number VARCHAR(255),
  barcode VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT releases_year_check
    CHECK (release_year IS NULL OR release_year BETWEEN 1900 AND 2200),
  CONSTRAINT releases_identity_key_check
    CHECK (identity_key ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX releases_identity_key_unique ON releases (identity_key);
CREATE INDEX releases_album_id_idx ON releases (album_id);

CREATE TABLE library_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  release_id UUID NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  list library_list NOT NULL,
  notes TEXT,
  confirmed_from_scan_id UUID REFERENCES scans(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT library_items_notes_length_check
    CHECK (notes IS NULL OR char_length(notes) <= 2000)
);

CREATE UNIQUE INDEX library_items_user_release_unique
  ON library_items (user_id, release_id);
CREATE INDEX library_items_user_list_created_idx
  ON library_items (user_id, list, created_at);

CREATE TABLE scan_confirmations (
  scan_id UUID PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  selected_candidate_id UUID REFERENCES scan_candidates(id) ON DELETE SET NULL,
  release_id UUID NOT NULL REFERENCES releases(id) ON DELETE RESTRICT,
  library_item_id UUID NOT NULL REFERENCES library_items(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scan_confirmations_idempotency_key_length_check
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  CONSTRAINT scan_confirmations_request_fingerprint_check
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX scan_confirmations_user_idempotency_unique
  ON scan_confirmations (user_id, idempotency_key);
