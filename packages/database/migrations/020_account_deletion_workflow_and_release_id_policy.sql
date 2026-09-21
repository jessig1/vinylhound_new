-- P4.2 Task 6 (new ADR, superseding ADR-0014's deletion mechanism and
-- amending ADR-0028): replaces the two cross-boundary release_id "restrict"
-- FKs with "set null" + durable audit projections, and makes account
-- deletion a durable, drain-then-delete workflow.

-- scan_confirmations.release_id: a completed row's release_id still cannot
-- actually go null in practice -- scan_confirmations_status_consistency_check
-- (migration 019) requires it non-null whenever status = 'completed', so a
-- DELETE FROM releases referenced by a completed confirmation still fails,
-- just via that check constraint instead of this FK. A pending row already
-- has release_id NULL. This only removes the literal cross-schema restrict
-- dependency ahead of Task 7's physical schema/role split; protected-history
-- behavior for a completed confirmation is unchanged.
ALTER TABLE scan_confirmations DROP CONSTRAINT scan_confirmations_release_id_fkey;
ALTER TABLE scan_confirmations
  ADD CONSTRAINT scan_confirmations_release_id_fkey
  FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE SET NULL;

-- confirmation_receipts.release_id: a dedupe/audit record, not a protected
-- reference -- matching its own sibling library_item_id/copy_id columns,
-- which were already `set null`. payload keeps the resolved release id for
-- history even once nulled.
ALTER TABLE confirmation_receipts ALTER COLUMN release_id DROP NOT NULL;
ALTER TABLE confirmation_receipts DROP CONSTRAINT confirmation_receipts_release_id_fkey;
ALTER TABLE confirmation_receipts
  ADD CONSTRAINT confirmation_receipts_release_id_fkey
  FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE SET NULL;

-- Account deletion becomes a durable, drain-then-delete workflow: a whole
-- account delete is deferred, not blocked, while any scan_confirmations row
-- for that user is still `pending`, so a confirmation event already
-- dispatched to the queue before the delete request can still be processed
-- against a `users` row that still exists, instead of racing account
-- deletion into a foreign-key violation on library_items/library_copies'
-- user_id (ADR-0028's documented Task-6 gap).
ALTER TABLE users ADD COLUMN deletion_requested_at TIMESTAMPTZ;
