// What the CRM sync is allowed to write to a contact that already exists.
//
// Until now `upsertContact` PATCHed firstname, lastname, website and lifecyclestage onto
// whatever contact matched the email — from a public, unauthenticated endpoint. A customer
// who ran the free audit had their lifecycle stage reset to `lead`; anyone who knew a
// contact's address could rewrite their name and website on purpose. See
// docs/audit/03-hubspot.md H1 and M1.
//
// The rule these tests hold in place: fill a blank, never replace a value.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { upsertContact, syncAeoLead, type AeoLeadPayload } from '@/lib/hubspot';

interface Call { url: string; method: string; body: Record<string, unknown> }

let calls: Call[] = [];

/** Contact returned by the search step; null means "no such contact yet". */
function mockHubSpot(existing: { id: string; properties: Record<string, string> } | null) {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, method, body });

    // property bootstrap: pretend the group and every property already exist
    if (url.includes('/properties/contacts/groups/')) {
      return new Response(JSON.stringify({ name: 'aeo_audit_data' }), { status: 200 });
    }
    if (url.endsWith('/crm/v3/properties/contacts')) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (url.includes('/objects/contacts/search')) {
      return new Response(JSON.stringify({ results: existing ? [existing] : [] }), { status: 200 });
    }
    // create or update
    return new Response(JSON.stringify({ id: existing?.id ?? 'new-1', properties: {} }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
}

const writeCall = () => calls.find((c) => c.method === 'PATCH' || (c.method === 'POST' && c.url.endsWith('/objects/contacts')));
const writtenProps = () => (writeCall()?.body as { properties: Record<string, string> }).properties;

const AEO = { aeo_overall_score: 42, aeo_overall_grade: 'F' };
const OFFERED = { firstname: 'Ada', lastname: 'Lovelace', website: 'example.com', lifecyclestage: 'lead' };

beforeEach(() => {
  calls = [];
  vi.stubEnv('HUBSPOT_PRIVATE_APP_TOKEN', 'pat-test-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('upsertContact on a contact that already exists', () => {
  it('does not overwrite a populated name, website or lifecycle stage', async () => {
    mockHubSpot({
      id: '501',
      properties: {
        email: 'someone@example.com',
        firstname: 'Grace',
        lastname: 'Hopper',
        website: 'gracehopper.dev',
        lifecyclestage: 'customer',
      },
    });

    await upsertContact('someone@example.com', AEO, OFFERED);

    const props = writtenProps();
    expect(writeCall()?.method).toBe('PATCH');
    // the integration's own fields are written
    expect(props.aeo_overall_score).toBe('42');
    expect(props.aeo_overall_grade).toBe('F');
    // the contact's own fields are left alone — this is the whole point
    expect(props).not.toHaveProperty('firstname');
    expect(props).not.toHaveProperty('lastname');
    expect(props).not.toHaveProperty('website');
    expect(props).not.toHaveProperty('lifecyclestage');
  });

  it('a customer running the audit stays a customer', async () => {
    mockHubSpot({
      id: '502',
      properties: { email: 'buyer@example.com', lifecyclestage: 'customer' },
    });

    await upsertContact('buyer@example.com', AEO, OFFERED);

    expect(writtenProps()).not.toHaveProperty('lifecyclestage');
  });

  it('fills fields that are blank, because that is the useful half', async () => {
    mockHubSpot({
      id: '503',
      properties: { email: 'sparse@example.com', firstname: '', lastname: '   ', website: '' },
    });

    await upsertContact('sparse@example.com', AEO, OFFERED);

    const props = writtenProps();
    expect(props.firstname).toBe('Ada');
    expect(props.lastname).toBe('Lovelace');
    expect(props.website).toBe('example.com');
    // absent from the search response counts as blank
    expect(props.lifecyclestage).toBe('lead');
  });

  it('writes no standard field when the search response carries no properties at all', async () => {
    // If we cannot see the contact's current values, every field looks blank — and filling
    // on that assumption is the overwrite this whole change exists to prevent.
    mockHubSpot({ id: '505' } as unknown as { id: string; properties: Record<string, string> });

    await upsertContact('invisible@example.com', AEO, OFFERED);

    const props = writtenProps();
    expect(props.aeo_overall_grade).toBe('F');
    expect(props).not.toHaveProperty('firstname');
    expect(props).not.toHaveProperty('website');
    expect(props).not.toHaveProperty('lifecyclestage');
  });

  it('asks the search step for the fields it might fill', async () => {
    mockHubSpot({ id: '504', properties: { email: 'x@example.com' } });

    await upsertContact('x@example.com', AEO, OFFERED);

    const search = calls.find((c) => c.url.includes('/objects/contacts/search'));
    expect(search?.body.properties).toEqual(
      expect.arrayContaining(['email', 'firstname', 'lastname', 'website', 'lifecyclestage']),
    );
  });
});

describe('upsertContact on a new contact', () => {
  it('writes everything, since there is nothing to preserve', async () => {
    mockHubSpot(null);

    await upsertContact('brand-new@example.com', AEO, OFFERED);

    const props = writtenProps();
    expect(writeCall()?.method).toBe('POST');
    expect(props.email).toBe('brand-new@example.com');
    expect(props.firstname).toBe('Ada');
    expect(props.lifecyclestage).toBe('lead');
    expect(props.aeo_overall_grade).toBe('F');
  });
});

describe('upsertContact guards', () => {
  it('skips entirely when no token is configured', async () => {
    vi.stubEnv('HUBSPOT_PRIVATE_APP_TOKEN', '');
    mockHubSpot(null);

    const result = await upsertContact('someone@example.com', AEO, OFFERED);

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('skips when called without an email', async () => {
    mockHubSpot(null);

    const result = await upsertContact('', AEO, OFFERED);

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

/* The end-to-end shape, because upsertContact's third argument only matters if syncAeoLead
   actually uses it. This is the test that fails against the old implementation, where the
   standard fields travelled in `properties` and were PATCHed unconditionally. */
describe('syncAeoLead against an existing customer record', () => {
  const payload: AeoLeadPayload = {
    fullName: 'Ada Lovelace',
    email: 'buyer@example.com',
    auditedDomain: 'https://audited-site.com',
    auditReportUrl: 'https://aeo.campaigncreators.com/audit/abc',
    overallScore: 42,
    overallGrade: 'F',
    answerabilityScore: 70,
    structureScore: 50,
    trustScore: 40,
    freshnessScore: 0,
    schemaScore: 20,
    enginesCited: ['Claude'],
    enginesMissing: ['ChatGPT'],
    citationRate: '3/40',
    topWeakness: 'Freshness',
    auditDate: '2026-09-22T00:00:00.000Z',
  };

  it('leaves the lifecycle stage, name and website exactly as they were', async () => {
    mockHubSpot({
      id: '900',
      properties: {
        email: 'buyer@example.com',
        firstname: 'Grace',
        lastname: 'Hopper',
        website: 'their-own-company.com',
        lifecyclestage: 'customer',
      },
    });

    await syncAeoLead(payload);

    const props = writtenProps();
    expect(props).not.toHaveProperty('lifecyclestage');
    expect(props).not.toHaveProperty('firstname');
    expect(props).not.toHaveProperty('lastname');
    expect(props).not.toHaveProperty('website');
    // the audit data still lands, which is the point of the integration
    expect(props.aeo_overall_grade).toBe('F');
    expect(props.aeo_audit_url).toBe('https://aeo.campaigncreators.com/audit/abc');
  });
});
