-- Favorites and user-owned ordered playlists over saved records (ADR-0021,
-- roadmap P3.3 Task 2).
--
-- A favorite is an attribute of the user's saved relationship to a release —
-- the existing library_items row — rather than a third list or a separate
-- table. A record in either list can be a favorite, and removing the record
-- removes the favorite with it, so nothing can be favorited that is not
-- saved and account export/deletion cover it without new plumbing.
ALTER TABLE library_items
  ADD COLUMN favorited_at TIMESTAMPTZ;

CREATE INDEX library_items_user_favorited_at_idx
  ON library_items (user_id, favorited_at)
  WHERE favorited_at IS NOT NULL;

-- A playlist organizes saved music. Names are unique per user after
-- normalization (case folded, whitespace collapsed), so creating "Road Trip"
-- twice converges on one playlist instead of stacking duplicates.
CREATE TABLE playlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  normalized_name VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT playlists_name_check
    CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT playlists_normalized_name_check
    CHECK (char_length(normalized_name) BETWEEN 1 AND 100)
);

CREATE UNIQUE INDEX playlists_user_normalized_name_unique
  ON playlists (user_id, normalized_name);
CREATE INDEX playlists_user_updated_at_idx
  ON playlists (user_id, updated_at);

-- Each entry references one of the user's own library items — a saved
-- release, never a bare catalog result — so a playlist can only hold music
-- the user has saved, and deleting the saved record deletes its entries.
-- user_id is denormalized (as on library_copies) so ownership is visible on
-- the row itself. position is unique per playlist and ascending but not
-- necessarily contiguous: a cascade delete leaves a gap; a reorder renumbers.
CREATE TABLE playlist_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  library_item_id UUID NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT playlist_entries_position_check CHECK (position > 0)
);

CREATE UNIQUE INDEX playlist_entries_playlist_item_unique
  ON playlist_entries (playlist_id, library_item_id);
CREATE UNIQUE INDEX playlist_entries_playlist_position_unique
  ON playlist_entries (playlist_id, position);
CREATE INDEX playlist_entries_library_item_id_idx
  ON playlist_entries (library_item_id);
