-- =============================================================================
-- 006: Remove anon/authenticated access to the remaining public-schema objects
-- =============================================================================
-- Follow-up to 005. These objects either exist only on the live DB (made in
-- the dashboard, never written to a migration) or were left without RLS by
-- 001, and Supabase grants anon/authenticated ALL on new public tables:
--   * audit_overview (live only): per the B1 audit doc it joins leads, so if it
--     is a plain view anon can read every lead name and email through it.
--   * audit_rate_limits (live only): anon could read visitor IPs, or delete
--     its own rows to reset the per-IP limit on paid audits.
--   * profiles, _handle_new_user_errors (001): no RLS; signup emails.
-- The app reads all of these with service_role only (src/lib/rateLimit.ts).
-- Each object is guarded, so this runs on a DB where any of them is missing.
-- RLS is not enabled on profiles/_handle_new_user_errors here: the signup
-- trigger writes to them and only needs table privileges, not policies.

DO $$
BEGIN
  IF to_regclass('public.audit_overview') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.audit_overview FROM anon, authenticated;
  END IF;
  IF to_regclass('public.audit_rate_limits') IS NOT NULL THEN
    ALTER TABLE public.audit_rate_limits ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE public.audit_rate_limits FROM anon, authenticated;
  END IF;
  IF to_regclass('public.profiles') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.profiles FROM anon, authenticated;
  END IF;
  IF to_regclass('public._handle_new_user_errors') IS NOT NULL THEN
    REVOKE ALL ON TABLE public._handle_new_user_errors FROM anon, authenticated;
  END IF;
END
$$;
