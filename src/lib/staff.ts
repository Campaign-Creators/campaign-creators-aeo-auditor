import { createClient } from '@supabase/supabase-js';

/**
 * Staff mode (TDD FR-014). A caller is staff when its bearer token is a valid Supabase
 * sign-in for an email on AEO_STAFF_EMAILS. Any doubt means public: no list, no token,
 * a token that does not verify, or an auth error.
 */
export function staffList(): string[] {
  return (process.env.AEO_STAFF_EMAILS ?? '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
}

type TokenUser = { email?: string | null; email_confirmed_at?: string | null } | null;
type Verify = (token: string) => Promise<TokenUser>;

/** The token's user, checked server-side with the service client. */
const verifyWithSupabase: Verify = async (token) => {
  const supabase = createClient(
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim(),
    (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { data, error } = await supabase.auth.getUser(token);
  return error ? null : data.user ?? null;
};

/** The staff member's email, or null for a public caller. */
export async function staffEmail(
  request: { headers: Headers },
  verify: Verify = verifyWithSupabase,
): Promise<string | null> {
  const list = staffList();
  if (list.length === 0) return null;
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return null;
  try {
    const user = await verify(token);
    // An unconfirmed address proves nothing: anyone can sign up with an email they don't own.
    if (!user?.email_confirmed_at) return null;
    const email = user.email?.trim().toLowerCase();
    return email && list.includes(email) ? email : null;
  } catch (err) {
    console.error('[staff] token check failed; treating the caller as public:', err);
    return null;
  }
}
