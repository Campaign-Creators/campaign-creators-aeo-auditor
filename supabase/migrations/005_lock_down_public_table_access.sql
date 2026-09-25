-- =============================================================================
-- 005: Remove anon/authenticated access to audit and lead tables
-- =============================================================================
-- Every server route reads and writes these tables with the service_role key,
-- which bypasses RLS. No code path queries them with the anon key or as a
-- signed-in user. The policies from 001 therefore only served the public
-- anon key (shipped in the browser bundle) and anyone who signs up:
--   * authenticated_only_leads: any signed-up user could read/write every lead
--   * anon_select_audit_requests: anyone could read every audited URL, IP, UTM
--   * anon/authenticated SELECT on audit_results: every report, no unlock needed
-- The REVOKEs are the main control: without table privileges a role cannot
-- read the table at all. Dropping the policies and keeping RLS on is the backstop.
-- service_role keeps its access (service_role_insert_leads from 002, and its
-- BYPASSRLS attribute).
--
-- audit_summary is a plain view, so it runs with its owner's rights and
-- ignores RLS. Nothing in the repo reads it, so anon/authenticated lose it too.
-- audit_overview (live only, not created by any migration) is NOT touched here.

DROP POLICY IF EXISTS authenticated_only_leads ON leads;
DROP POLICY IF EXISTS anon_select_audit_requests ON audit_requests;
DROP POLICY IF EXISTS authenticated_all_own_audit_requests ON audit_requests;
DROP POLICY IF EXISTS anon_select_audit_results ON audit_results;
DROP POLICY IF EXISTS authenticated_select_audit_results ON audit_results;

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_results ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE leads FROM anon, authenticated;
REVOKE ALL ON TABLE audit_requests FROM anon, authenticated;
REVOKE ALL ON TABLE audit_results FROM anon, authenticated;

DO $$
BEGIN
  IF to_regclass('public.audit_summary') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.audit_summary FROM anon, authenticated;
  END IF;
END
$$;
