-- =============================================================================
-- DRAFT 008: mark audits started by staff (TDD FR-014, task AEO-T-013)
-- =============================================================================
-- Additive and nullable: existing rows and the current code are unaffected.
-- Apply BEFORE setting AEO_STAFF_EMAILS in any environment: with staff configured,
-- the app writes requested_by = 'staff' on staff audits and counts only rows where
-- requested_by IS NULL toward the daily cap. Without the column those queries fail.

-- STEP 1 (read-only)
--   begin read only;
--   select column_name from information_schema.columns
--     where table_schema = 'public' and table_name = 'audit_requests' and column_name = 'requested_by';  [0 rows]
--   rollback;

-- STEP 2
SET lock_timeout = '3s';
ALTER TABLE public.audit_requests ADD COLUMN IF NOT EXISTS requested_by text;
COMMENT ON COLUMN public.audit_requests.requested_by IS
  'NULL for public visitors; ''staff'' for audits started by an allow-listed staff sign-in.';

-- STEP 3 (read-only)
--   select data_type, is_nullable from information_schema.columns
--     where table_schema = 'public' and table_name = 'audit_requests' and column_name = 'requested_by';  [text, YES]
--   select count(*) from public.audit_requests where requested_by is not null;                         [0]
