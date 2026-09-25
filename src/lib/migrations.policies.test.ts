import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Replays the policy, grant and RLS statements in supabase/migrations (in file
// order) and checks the end state. The app only touches these tables with the
// service_role key, so the public anon key and signed-up users must have no
// way in. See migration 005. Statements inside DO $$ blocks are not parsed.
const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');
const PROTECTED_TABLES = ['leads', 'audit_requests', 'audit_results'];
const PUBLIC_ROLES = ['anon', 'authenticated', 'public'];

type Policy = { name: string; table: string; roles: string[] };

// Identifier, optionally schema-qualified and/or double-quoted. Unquoted names
// fold to lower case, as Postgres does.
const IDENT = String.raw`(?:"?public"?\.)?("[^"]+"|\w+)`;
const ROLES = String.raw`([\w\s,]+?)`;
const ident = (raw: string) => (raw.startsWith('"') ? raw.slice(1, -1) : raw.toLowerCase());
const roleList = (raw: string) => raw.split(',').map((r) => r.trim().toLowerCase());
const re = (pattern: string) => new RegExp(pattern, 'i');

const CREATE_POLICY = re(`^CREATE POLICY ${IDENT} ON ${IDENT}(.*)$`);
const POLICY_TO = re(String.raw`\bTO ${ROLES}(?: USING| WITH CHECK|$)`);
const ALTER_POLICY = re(`^ALTER POLICY ${IDENT} ON ${IDENT}(.*)$`);
const DROP_POLICY = re(`^DROP POLICY (?:IF EXISTS )?${IDENT} ON ${IDENT}$`);
const TABLE_RLS = re(`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${IDENT} (ENABLE|DISABLE) ROW LEVEL SECURITY$`);
const GRANT_REVOKE = re(
  `^(GRANT|REVOKE) (.*?) ON (?:TABLE )?${IDENT} (?:TO|FROM) ${ROLES}(?: WITH GRANT OPTION| CASCADE| RESTRICT)?$`,
);

function replayMigrations() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const policies = new Map<string, Policy>();
  const revoked = new Set<string>();
  const rlsDisabled = new Set<string>();

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8').replace(/--.*$/gm, '');
    for (const raw of sql.split(';')) {
      const stmt = raw.replace(/\s+/g, ' ').trim();

      const create = stmt.match(CREATE_POLICY);
      if (create) {
        const [name, table] = [ident(create[1]), ident(create[2])];
        const to = create[3].match(POLICY_TO);
        policies.set(`${table}.${name}`, { name, table, roles: to ? roleList(to[1]) : ['public'] });
        continue;
      }

      const alter = stmt.match(ALTER_POLICY);
      if (alter) {
        const key = `${ident(alter[2])}.${ident(alter[1])}`;
        const existing = policies.get(key);
        const rename = alter[3].match(re(`^ RENAME TO ${IDENT}$`));
        const to = alter[3].match(POLICY_TO);
        if (existing && rename) {
          policies.delete(key);
          existing.name = ident(rename[1]);
          policies.set(`${existing.table}.${existing.name}`, existing);
        } else if (existing && to) {
          existing.roles = roleList(to[1]);
        }
        continue;
      }

      const drop = stmt.match(DROP_POLICY);
      if (drop) {
        policies.delete(`${ident(drop[2])}.${ident(drop[1])}`);
        continue;
      }

      const rls = stmt.match(TABLE_RLS);
      if (rls) {
        const table = ident(rls[1]);
        if (rls[2].toUpperCase() === 'DISABLE') rlsDisabled.add(table);
        else rlsDisabled.delete(table);
        continue;
      }

      const grant = stmt.match(GRANT_REVOKE);
      if (grant) {
        const isGrant = grant[1].toUpperCase() === 'GRANT';
        const isFullRevoke = !isGrant && /^ALL( PRIVILEGES)?$/i.test(grant[2]);
        for (const role of roleList(grant[4])) {
          const key = `${ident(grant[3])}:${role}`;
          if (isGrant) revoked.delete(key);
          else if (isFullRevoke) revoked.add(key);
        }
      }
    }
  }
  return { policies: [...policies.values()], revoked, rlsDisabled };
}

describe('supabase migrations: public access to audit and lead tables', () => {
  const { policies, revoked, rlsDisabled } = replayMigrations();

  it.each(PROTECTED_TABLES)('%s has no policy for anon, authenticated or public', (table) => {
    const open = policies.filter(
      (p) => p.table === table && p.roles.some((r) => PUBLIC_ROLES.includes(r)),
    );
    expect(open.map((p) => p.name)).toEqual([]);
  });

  it.each(PROTECTED_TABLES)('%s grants are revoked from anon and authenticated', (table) => {
    expect(revoked.has(`${table}:anon`)).toBe(true);
    expect(revoked.has(`${table}:authenticated`)).toBe(true);
  });

  it.each(PROTECTED_TABLES)('%s keeps row level security on', (table) => {
    expect(rlsDisabled.has(table)).toBe(false);
  });

  it('keeps service_role access to leads for the unlock route', () => {
    const serviceRole = policies.filter(
      (p) => p.table === 'leads' && p.roles.includes('service_role'),
    );
    expect(serviceRole.length).toBeGreaterThan(0);
  });
});
