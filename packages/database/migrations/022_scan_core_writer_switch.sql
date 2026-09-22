-- Up Migration

-- P4.2 Task 7 (ADR-0030): the single writer switch. After this migration no
-- transaction can cross the scan/core boundary, because no constraint does
-- -- the GRANT boundary migration 021 established is no longer merely
-- reinforced by these FKs, it is the only thing enforcing the split. Apply
-- this only after the application deploy that reads and writes through the
-- two role-scoped connections migration 021 prepared (021 + that deploy are
-- together the roadmap's "additive, backfill, verify" half of this task);
-- never run it against code that still opens one transaction spanning both
-- schemas.

SET search_path = scan, core, public;

-- scan -> core.users. ADR-0027: "scan's user_id columns stop being foreign
-- keys into core.users and become plain UUID attributes whose validity is
-- guaranteed by the authenticated request path that writes them." The
-- cascade delete these FKs provided is replaced by
-- deleteScanDataForUser()'s own explicit, ordered delete
-- (account-repository.ts), driven by the same account-deletion workflow that
-- used to rely on this cascade.
ALTER TABLE scan.scans              DROP CONSTRAINT scans_user_id_fkey;
ALTER TABLE scan.batches            DROP CONSTRAINT batches_user_id_fkey;
ALTER TABLE scan.scan_confirmations DROP CONSTRAINT scan_confirmations_user_id_fkey;

-- core -> scan.scans. confirmed_from_scan_id becomes a fixed audit
-- reference: deleting a scan no longer nulls it (a deliberate behavior
-- change from the old ON DELETE SET NULL), so a library item keeps naming
-- the scan it came from for as long as the item exists. Display already
-- reads from library_items.confirmed_release (migration 021), not a live
-- join through this column, so nothing user-visible depends on the old
-- nulling behavior.
ALTER TABLE core.library_items  DROP CONSTRAINT library_items_confirmed_from_scan_id_fkey;
ALTER TABLE core.library_copies DROP CONSTRAINT library_copies_confirmed_from_scan_id_fkey;

-- scan -> core.releases / core.library_items / core.library_copies.
-- Dropping release_id's FK removes its ON DELETE SET NULL action entirely,
-- which is also what used to trigger migration 020's status-consistency
-- check on a completed row and block the delete with a 23514 error -- that
-- protection only ever fired because the FK's SET NULL action ran the
-- UPDATE the check then rejected. With no FK, deleting a releases row now
-- succeeds unconditionally and leaves any confirmation_receipts/
-- scan_confirmations row that named it with a dangling, unenforced
-- release_id. Safe today only because no code path deletes a releases row
-- (ADR-0029); if one is ever written, it must preserve the audit row itself
-- (release_id may go stale, but reviewed_release/payload keep the original
-- values) since the database no longer will. library_item_id's and
-- copy_id's own set-null behavior is replaced by deleteLibraryItem's and
-- deleteLibraryCopy's application-level best-effort null-back plus
-- readConfirmationResponse's liveness check and lazy self-heal (see the
-- Task 7 ADR and confirmation-repository.ts).
ALTER TABLE scan.scan_confirmations DROP CONSTRAINT scan_confirmations_release_id_fkey;
ALTER TABLE scan.scan_confirmations DROP CONSTRAINT scan_confirmations_library_item_id_fkey;
ALTER TABLE scan.scan_confirmations DROP CONSTRAINT scan_confirmations_copy_id_fkey;

-- Several of the dropped FKs backed an index the deletion workflow and the
-- reconciliation/export code still query by; replace what each one actually
-- provided.
CREATE INDEX IF NOT EXISTS scan_confirmations_user_id_status_idx
  ON scan.scan_confirmations (user_id, status);
CREATE INDEX IF NOT EXISTS library_items_confirmed_from_scan_id_idx
  ON core.library_items (confirmed_from_scan_id)
  WHERE confirmed_from_scan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS outbox_messages_aggregate_id_pending_idx
  ON scan.outbox_messages (aggregate_id)
  WHERE published_at IS NULL;

-- Down Migration

SET search_path = scan, core, public;

DROP INDEX IF EXISTS scan.outbox_messages_aggregate_id_pending_idx;
DROP INDEX IF EXISTS core.library_items_confirmed_from_scan_id_idx;
DROP INDEX IF EXISTS scan.scan_confirmations_user_id_status_idx;

-- Added NOT VALID: a row orphaned while these FKs were absent (a scan
-- deleted for a user whose library items still name it, say) must not make
-- rollback itself fail. Run `ALTER TABLE ... VALIDATE CONSTRAINT` separately,
-- after reconciling any such row, to restore full enforcement.
ALTER TABLE scan.scans ADD CONSTRAINT scans_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES core.users(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE scan.batches ADD CONSTRAINT batches_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES core.users(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE scan.scan_confirmations ADD CONSTRAINT scan_confirmations_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES core.users(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE core.library_items ADD CONSTRAINT library_items_confirmed_from_scan_id_fkey
  FOREIGN KEY (confirmed_from_scan_id) REFERENCES scan.scans(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE core.library_copies ADD CONSTRAINT library_copies_confirmed_from_scan_id_fkey
  FOREIGN KEY (confirmed_from_scan_id) REFERENCES scan.scans(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE scan.scan_confirmations ADD CONSTRAINT scan_confirmations_release_id_fkey
  FOREIGN KEY (release_id) REFERENCES core.releases(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE scan.scan_confirmations ADD CONSTRAINT scan_confirmations_library_item_id_fkey
  FOREIGN KEY (library_item_id) REFERENCES core.library_items(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE scan.scan_confirmations ADD CONSTRAINT scan_confirmations_copy_id_fkey
  FOREIGN KEY (copy_id) REFERENCES core.library_copies(id) ON DELETE SET NULL NOT VALID;
