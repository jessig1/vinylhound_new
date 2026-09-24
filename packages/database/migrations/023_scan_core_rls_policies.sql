-- Up Migration

-- Fixes a live regression found 2026-09-24: development's Supabase database
-- has row-level security enabled on every table (Supabase's dashboard
-- defaults to this; nothing in this repo's migration history ever ran
-- ENABLE ROW LEVEL SECURITY on scan/core tables), while migration 021 only
-- set up plain GRANTs for vinylhound_scan_app/vinylhound_core_app -- neither
-- role owns its tables (021's down migration says so explicitly: "all
-- tables are owned by the master role that ran this migration"). RLS blocks
-- every write from a non-owner role with no policy in place, no matter what
-- it was GRANTed, so this broke every first-time Clerk sign-in
-- (requireUserId's JIT-provisioning INSERT into core.users) as soon as
-- migration 022 switched the app to connect as the non-owner role. Aurora
-- (staging/production) never had RLS enabled, so it was unaffected -- until
-- now, silently, if RLS were ever toggled on there too.
--
-- This migration makes RLS explicit and identical across every environment
-- instead of depending on Supabase dashboard state: ENABLE ROW LEVEL
-- SECURITY on every existing scan/core table (a no-op for the owning role,
-- which always bypasses RLS) and one permissive policy per table for that
-- table's own app role, reproducing exactly what 021's GRANTs already
-- intended to allow. A future migration that adds a new table to either
-- schema must add its own ENABLE ROW LEVEL SECURITY + CREATE POLICY pair --
-- unlike GRANTs, Postgres has no ALTER DEFAULT PRIVILEGES equivalent for RLS.

DO $$
DECLARE
  tbl RECORD;
BEGIN
  FOR tbl IN SELECT tablename FROM pg_tables WHERE schemaname = 'scan' LOOP
    EXECUTE format('ALTER TABLE scan.%I ENABLE ROW LEVEL SECURITY', tbl.tablename);
    EXECUTE format(
      'CREATE POLICY scan_app_full_access ON scan.%I FOR ALL TO vinylhound_scan_app USING (true) WITH CHECK (true)',
      tbl.tablename
    );
  END LOOP;

  FOR tbl IN SELECT tablename FROM pg_tables WHERE schemaname = 'core' LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', tbl.tablename);
    EXECUTE format(
      'CREATE POLICY core_app_full_access ON core.%I FOR ALL TO vinylhound_core_app USING (true) WITH CHECK (true)',
      tbl.tablename
    );
  END LOOP;
END
$$;

-- Down Migration

DO $$
DECLARE
  tbl RECORD;
BEGIN
  FOR tbl IN SELECT tablename FROM pg_tables WHERE schemaname = 'scan' LOOP
    EXECUTE format('DROP POLICY IF EXISTS scan_app_full_access ON scan.%I', tbl.tablename);
    EXECUTE format('ALTER TABLE scan.%I DISABLE ROW LEVEL SECURITY', tbl.tablename);
  END LOOP;

  FOR tbl IN SELECT tablename FROM pg_tables WHERE schemaname = 'core' LOOP
    EXECUTE format('DROP POLICY IF EXISTS core_app_full_access ON core.%I', tbl.tablename);
    EXECUTE format('ALTER TABLE core.%I DISABLE ROW LEVEL SECURITY', tbl.tablename);
  END LOOP;
END
$$;
