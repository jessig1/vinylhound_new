-- node-pg-migrate creates its bookkeeping table in the public schema. Supabase
-- exposes that schema through PostgREST, so migration metadata must never be
-- available to browser-facing roles.
ALTER TABLE public.vinylhound_migrations ENABLE ROW LEVEL SECURITY;

-- Remove both the PostgreSQL default role and any direct Supabase API-role
-- grants. The conditional block keeps local and AWS PostgreSQL environments,
-- which do not define Supabase's roles, able to run this migration.
REVOKE ALL PRIVILEGES ON TABLE public.vinylhound_migrations FROM PUBLIC;

DO $$
DECLARE
  api_role TEXT;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.vinylhound_migrations FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END $$;
