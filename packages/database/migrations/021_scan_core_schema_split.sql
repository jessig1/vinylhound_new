-- Up Migration

-- P4.2 Task 7 (new ADR-0030, completing ADR-0027): physically separates
-- `scan` and `core` into two Postgres schemas with two least-privilege
-- roles, still inside one physical database. Additive and behavior-neutral:
-- every cross-schema foreign key below survives this migration unchanged
-- (Postgres referential-integrity checks run with the referenced table's
-- owner rights, not the connecting role's, so a GRANT boundary alone does
-- not break them), and unqualified SQL keeps resolving through search_path.
-- The writer switch -- dropping those FKs, so no transaction can cross the
-- boundary regardless of connection -- is migration 022, applied only after
-- the application deploy that reads/writes through the two role-scoped
-- connections this migration's GRANTs prepare.
--
-- The two roles (vinylhound_scan_app / vinylhound_core_app) are created by
-- ensureDatabaseRoles() (packages/database/src/roles.ts) immediately before
-- this runner starts, because a plain .sql migration cannot read the
-- per-environment passwords from the environment the way that function does.

SET search_path = public;

CREATE SCHEMA IF NOT EXISTS scan;
CREATE SCHEMA IF NOT EXISTS core;

-- 7 scan-owned tables (ADR-0027).
ALTER TABLE public.scans              SET SCHEMA scan;
ALTER TABLE public.batches            SET SCHEMA scan;
ALTER TABLE public.image_assets       SET SCHEMA scan;
ALTER TABLE public.scan_attempts      SET SCHEMA scan;
ALTER TABLE public.scan_candidates    SET SCHEMA scan;
ALTER TABLE public.scan_confirmations SET SCHEMA scan;
ALTER TABLE public.outbox_messages    SET SCHEMA scan;

-- 9 core-owned tables (ADR-0027 names 8; confirmation_receipts is core-owned
-- per ADR-0028's own doc comment, predating this migration).
ALTER TABLE public.users                 SET SCHEMA core;
ALTER TABLE public.albums                SET SCHEMA core;
ALTER TABLE public.releases              SET SCHEMA core;
ALTER TABLE public.catalog_references    SET SCHEMA core;
ALTER TABLE public.library_items         SET SCHEMA core;
ALTER TABLE public.library_copies        SET SCHEMA core;
ALTER TABLE public.playlists             SET SCHEMA core;
ALTER TABLE public.playlist_entries      SET SCHEMA core;
ALTER TABLE public.confirmation_receipts SET SCHEMA core;

-- public.vinylhound_migrations deliberately stays in public (migration 014's
-- RLS and REVOKE apply to it by that exact name), and so do the enum types
-- (pgEnum has no schema qualifier anywhere in schema.ts) -- which is why
-- every search_path set below keeps public last.

SET search_path = scan, core, public;

-- Privileges. Neither app role is granted USAGE on the other's schema, so a
-- query issued on the wrong connection fails with a real permission error
-- (insufficient_privilege), not a silent cross-schema read.
GRANT USAGE ON SCHEMA scan TO vinylhound_scan_app;
GRANT USAGE ON SCHEMA core TO vinylhound_core_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA scan TO vinylhound_scan_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO vinylhound_core_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA scan GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vinylhound_scan_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vinylhound_core_app;
-- No sequences exist today (every id is a uuid default), but this keeps a
-- future serial column from silently failing at runtime for lack of a grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA scan GRANT USAGE ON SEQUENCES TO vinylhound_scan_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT USAGE ON SEQUENCES TO vinylhound_core_app;
REVOKE ALL ON SCHEMA scan FROM vinylhound_core_app;
REVOKE ALL ON SCHEMA core FROM vinylhound_scan_app;

-- Name resolution. Each pool also sets search_path per connection
-- (DatabaseOptions.searchPath, packages/database/src/database.ts) via the
-- startup `options` parameter, which is what actually matters for a pooled
-- connection opened before this migration ran; these ALTERs are the
-- defaults for psql, ad hoc ops connections, and the master/migration role.
-- `ALTER DATABASE`/`ALTER ROLE ... IN DATABASE` both require a literal
-- database name, not an expression, so current_database() is resolved
-- through EXECUTE format() -- this migration runs against differently named
-- databases across environments (e.g. the e2e suite's `vinylhound_e2e`,
-- distinct from local dev's `vinylhound`), and a literal "vinylhound" here
-- would silently no-op for any of them.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = scan, core, public', current_database());
  EXECUTE format('ALTER ROLE vinylhound_scan_app IN DATABASE %I SET search_path = scan, public', current_database());
  EXECUTE format('ALTER ROLE vinylhound_core_app IN DATABASE %I SET search_path = core, public', current_database());
END
$$;

-- Denormalized confirmation snapshot (P4.2 Task 7). Library reads sort,
-- search, and serialize using the values a user confirmed on the scan a
-- saved record came from, today via a left join into
-- scan.scan_confirmations.reviewed_release (library-repository.ts). That
-- join cannot survive the writer switch: ORDER BY and keyset pagination
-- evaluate it in SQL over the whole library (ADR-0023), which is not
-- something two separate role-scoped connections can do together. Written at
-- confirmation time by processScanConfirmation from the scan.confirmed.v1
-- event payload, which already carries every field
-- (ScanConfirmedEventSchema spreads the identical ReviewedReleaseShape) --
-- no cross-schema read is needed at write time either. Backfilled here from
-- existing data while a single migration connection can still see both
-- schemas.
ALTER TABLE core.library_items ADD COLUMN confirmed_release JSONB;
ALTER TABLE core.library_items
  ADD CONSTRAINT library_items_confirmed_release_check
  CHECK (confirmed_release IS NULL OR jsonb_typeof(confirmed_release) = 'object');

UPDATE core.library_items li
   SET confirmed_release = sc.reviewed_release
  FROM scan.scan_confirmations sc
 WHERE sc.scan_id = li.confirmed_from_scan_id;

-- Scan-side deletion tombstone (P4.2 Task 7). confirmScan reads
-- core.users.deletion_requested_at FOR SHARE (ADR-0029) to refuse a new
-- confirmation for an account being deleted; scan can no longer read core's
-- table once the writer switch enforces the GRANT boundary, so the flag is
-- replicated into scan. Written first by DELETE /api/v1/account (via the
-- scan connection), before core.users is marked (via the core connection) --
-- the fail-safe direction is "refuses confirmations, but the account is not
-- yet actually deleted."
CREATE TABLE scan.account_deletions (
  user_id      UUID PRIMARY KEY,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON scan.account_deletions TO vinylhound_scan_app;

INSERT INTO scan.account_deletions (user_id, requested_at)
SELECT id, deletion_requested_at FROM core.users WHERE deletion_requested_at IS NOT NULL
ON CONFLICT (user_id) DO NOTHING;

-- Down Migration

SET search_path = scan, core, public;

DROP TABLE IF EXISTS scan.account_deletions;
ALTER TABLE core.library_items DROP CONSTRAINT IF EXISTS library_items_confirmed_release_check;
ALTER TABLE core.library_items DROP COLUMN IF EXISTS confirmed_release;

DO $$
BEGIN
  EXECUTE format('ALTER ROLE vinylhound_scan_app IN DATABASE %I RESET search_path', current_database());
  EXECUTE format('ALTER ROLE vinylhound_core_app IN DATABASE %I RESET search_path', current_database());
  EXECUTE format('ALTER DATABASE %I RESET search_path', current_database());
END
$$;

ALTER TABLE scan.scans              SET SCHEMA public;
ALTER TABLE scan.batches            SET SCHEMA public;
ALTER TABLE scan.image_assets       SET SCHEMA public;
ALTER TABLE scan.scan_attempts      SET SCHEMA public;
ALTER TABLE scan.scan_candidates    SET SCHEMA public;
ALTER TABLE scan.scan_confirmations SET SCHEMA public;
ALTER TABLE scan.outbox_messages    SET SCHEMA public;
ALTER TABLE core.users                 SET SCHEMA public;
ALTER TABLE core.albums                SET SCHEMA public;
ALTER TABLE core.releases              SET SCHEMA public;
ALTER TABLE core.catalog_references    SET SCHEMA public;
ALTER TABLE core.library_items         SET SCHEMA public;
ALTER TABLE core.library_copies        SET SCHEMA public;
ALTER TABLE core.playlists             SET SCHEMA public;
ALTER TABLE core.playlist_entries      SET SCHEMA public;
ALTER TABLE core.confirmation_receipts SET SCHEMA public;

DROP SCHEMA IF EXISTS scan;
DROP SCHEMA IF EXISTS core;
-- Roles are left in place deliberately: dropping one requires reassigning or
-- dropping every object it owns, and it owns none (all tables are owned by
-- the master role that ran this migration). ensureDatabaseRoles()
-- re-ALTERs them harmlessly on the next forward run.
