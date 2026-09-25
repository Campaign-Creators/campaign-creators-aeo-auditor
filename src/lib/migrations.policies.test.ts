import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Replays the CREATE/DROP POLICY and REVOKE statements in supabase/migrations
// (in file order) and checks the end state. The app only touches these tables
// with the service_role key, so the public anon key and signed-up users must
// have no way in. See migration 005.
const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');
const PROTECTED_TABLES = ['leads', 'audit_requests', 'audit_results'];
const PUBLIC_ROLES = ['anon', 'authenticated', 'public'];

type Policy = { name: string; table: string; roles: string[] };

function replayMigrations() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const policies = new Map<string, Policy>();
  const revoked = new Set<string>();

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8').replace(/--.*$/gm, '');
    for (const raw of sql.split(';')) {
      const stmt = raw.replace(/\s+/g, ' ').trim();

      const create = stmt.match(/^CREATE POLICY (\w+) ON (?:public\.)?(\w+)(.*)$/i);
      if (create) {
        const [, name, table, rest] = create;
        const to = rest.match(/\bTO ([\w\s,]+?)(?: USING| WITH CHECK|$)/i);
        const roles = to ? to[1].split(',').map((r) => r.trim().toLowerCase()) : ['public'];
        policies.set(`${table}.${name}`, { name, table, roles });
        continue;
      }

      const drop = stmt.match(/^DROP POLICY (?:IF EXISTS )?(\w+) ON (?:public\.)?(\w+)$/i);
      if (drop) {
        policies.delete(`${drop[2]}.${drop[1]}`);
        continue;
      }

      const revoke = stmt.match(/^REVOKE ALL ON (?:TABLE )?(?:public\.)?(\w+) FROM ([\w\s,]+)$/i);
      if (revoke) {
        for (const role of revoke[2].split(',').map((r) => r.trim().toLowerCase())) {
          revoked.add(`${revoke[1]}:${role}`);
        }
      }
    }
  }
  return { policies: [...policies.values()], revoked };
}

describe('supabase migrations: public access to audit and lead tables', () => {
  const { policies, revoked } = replayMigrations();

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

  it('keeps service_role access to leads for the unlock route', () => {
    const serviceRole = policies.filter(
      (p) => p.table === 'leads' && p.roles.includes('service_role'),
    );
    expect(serviceRole.length).toBeGreaterThan(0);
  });
});
