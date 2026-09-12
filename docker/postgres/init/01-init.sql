-- ============================================================================
-- Fleet Fuel Management System — PostgreSQL instance init
-- Runs ONLY on first creation of the data volume (empty data directory).
-- It never touches an existing database — safe across updates/rebuilds.
-- ============================================================================

-- UTC inside the database; display timezone is handled by the apps
-- (containers get TZ=Africa/Nairobi from the environment). Uses the actual
-- database name so this works with any POSTGRES_DB value.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO ''UTC''', current_database());
END
$$;

-- Performance/sanity defaults appropriate for a small self-hosted fleet.
ALTER SYSTEM SET log_min_duration_statement = 1000;   -- log slow statements (ms)
ALTER SYSTEM SET max_connections = 100;
