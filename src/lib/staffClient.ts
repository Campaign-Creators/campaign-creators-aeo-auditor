import { createSupabaseBrowser } from '@/lib/supabase/browser';

/**
 * The browser's staff sign-in token as an Authorization header, or {} when nobody is
 * signed in (or Supabase isn't configured). The server decides whether it counts as staff.
 */
export async function staffAuthHeader(): Promise<Record<string, string>> {
  try {
    const { data } = await createSupabaseBrowser().auth.getSession();
    const token = data.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}
