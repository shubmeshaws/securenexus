-- Fix: P1010 "User securenexus was denied access on the database securenexus.public"
-- Run on the PostgreSQL server as superuser (postgres):
--   sudo -u postgres psql -d securenexus -f scripts/fix-postgres-public-schema.sql
-- Remote host:
--   psql -h 10.1.14.230 -U postgres -d securenexus -f scripts/fix-postgres-public-schema.sql

ALTER SCHEMA public OWNER TO securenexus;
GRANT ALL ON SCHEMA public TO securenexus;
GRANT CREATE ON SCHEMA public TO securenexus;
GRANT USAGE ON SCHEMA public TO securenexus;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO securenexus;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO securenexus;

-- Existing objects (if any were created by postgres)
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO securenexus;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO securenexus;
