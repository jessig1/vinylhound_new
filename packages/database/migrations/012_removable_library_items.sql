-- Removing a saved record must not require destroying the audit row proving
-- what the user confirmed from a scan. ADR-0011 made scan_confirmations.
-- library_item_id a `restrict` foreign key, which protected that audit trail
-- but left nearly every real library item permanently undeletable, since
-- almost all of them originate from a confirmed scan.
--
-- The confirmation row's audit value lives in scan_id, release_id,
-- reviewed_release (the JSONB snapshot of exactly what was confirmed), and
-- confirmed_at. None of those depend on the library item still existing, so
-- the reference becomes nullable and clears itself when the item is removed
-- (ADR-0018). release_id stays `restrict`: shared catalog rows are never
-- user-deletable, so nothing there needs relaxing.

ALTER TABLE scan_confirmations
  DROP CONSTRAINT scan_confirmations_library_item_id_fkey;

ALTER TABLE scan_confirmations
  ALTER COLUMN library_item_id DROP NOT NULL;

ALTER TABLE scan_confirmations
  ADD CONSTRAINT scan_confirmations_library_item_id_fkey
    FOREIGN KEY (library_item_id) REFERENCES library_items (id)
    ON DELETE SET NULL;
