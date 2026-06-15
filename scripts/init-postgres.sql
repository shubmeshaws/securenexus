-- SecureNexus PostgreSQL bootstrap (Ubuntu / PostgreSQL 15+)
-- 1. Replace YOUR_PASSWORD below (alphanumeric only — no @ : # %)
-- 2. Run: sudo -u postgres psql -f scripts/init-postgres.sql

CREATE USER securenexus WITH PASSWORD 'YOUR_PASSWORD';
CREATE DATABASE securenexus OWNER securenexus;

\c securenexus

-- PostgreSQL 15+ revokes CREATE on schema public from non-superusers.
-- Prisma needs the app user to manage tables in public.
ALTER SCHEMA public OWNER TO securenexus;
GRANT ALL ON SCHEMA public TO securenexus;
GRANT CREATE ON SCHEMA public TO securenexus;
GRANT USAGE ON SCHEMA public TO securenexus;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO securenexus;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO securenexus;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO securenexus;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO securenexus;
