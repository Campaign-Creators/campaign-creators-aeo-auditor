/**
 * HubSpot CRM integration for AEO Auditor lead sync.
 *
 * On first sync, automatically creates the "AEO Audit Data" property
 * group and all custom properties if they don't already exist.
 */

const HUBSPOT_API_BASE = 'https://api.hubapi.com';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HubSpotContactProperties = Record<
  string,
  string | number | boolean | null | undefined
>;

type HubSpotContactResponse = {
  id: string;
  properties: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
};

export interface AeoLeadPayload {
  fullName: string;
  email: string;
  auditedDomain: string;
  auditReportUrl: string;
  overallScore: number;
  overallGrade: string;
  answerabilityScore: number;
  structureScore: number;
  trustScore: number;
  freshnessScore: number;
  schemaScore: number;
  enginesCited: string[];
  enginesMissing: string[];
  citationRate: string;
  topWeakness: string;
  auditDate: string;
}

// ---------------------------------------------------------------------------
// Property definitions — these get auto-created in HubSpot
// ---------------------------------------------------------------------------

const PROPERTY_GROUP = 'aeo_audit_data';
const PROPERTY_GROUP_LABEL = 'AEO Audit Data';

interface PropertyDef {
  name: string;
  label: string;
  type: 'number' | 'string' | 'date';
  fieldType: 'number' | 'text' | 'date';
  description: string;
}

const AEO_PROPERTY_DEFINITIONS: PropertyDef[] = [
  { name: 'aeo_overall_score', label: 'AEO Overall Score', type: 'number', fieldType: 'number', description: 'Overall AEO visibility score (0–100)' },
  { name: 'aeo_overall_grade', label: 'AEO Overall Grade', type: 'string', fieldType: 'text', description: 'Letter grade: A+, A, B, C, D, or F' },
  { name: 'aeo_audit_url', label: 'AEO Audit Report URL', type: 'string', fieldType: 'text', description: 'Link to the full audit report' },
  { name: 'aeo_answerability_score', label: 'AEO Crawlability Score', type: 'number', fieldType: 'number', description: 'AI crawlability dimension score (0–100)' },
  { name: 'aeo_structure_score', label: 'AEO Structure Score', type: 'number', fieldType: 'number', description: 'Content structure dimension score (0–100)' },
  { name: 'aeo_trust_score', label: 'AEO Trust Score', type: 'number', fieldType: 'number', description: 'Authority & trust dimension score (0–100)' },
  { name: 'aeo_freshness_score', label: 'AEO Freshness Score', type: 'number', fieldType: 'number', description: 'Content freshness dimension score (0–100)' },
  { name: 'aeo_schema_score', label: 'AEO Schema Score', type: 'number', fieldType: 'number', description: 'Schema markup dimension score (0–100)' },
  { name: 'aeo_engines_cited', label: 'AEO Engines Cited', type: 'string', fieldType: 'text', description: 'AI engines that cited the brand (e.g. "Claude, Perplexity")' },
  { name: 'aeo_engines_missing', label: 'AEO Engines Missing', type: 'string', fieldType: 'text', description: 'AI engines that did NOT cite the brand' },
  { name: 'aeo_citation_rate', label: 'AEO Citation Rate', type: 'string', fieldType: 'text', description: 'Prompts cited ratio (e.g. "4/24")' },
  { name: 'aeo_top_weakness', label: 'AEO Top Weakness', type: 'string', fieldType: 'text', description: 'Lowest-scoring dimension name' },
  { name: 'aeo_audit_date', label: 'AEO Audit Date', type: 'date', fieldType: 'date', description: 'When the audit was run' },
  { name: 'aeo_lead_source', label: 'AEO Lead Source', type: 'string', fieldType: 'text', description: 'Always "AEO Auditor"' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  };
}

function normalizeProperties(
  email: string,
  properties: HubSpotContactProperties,
): Record<string, string> {
  const out: Record<string, string> = { email };
  for (const [key, value] of Object.entries(properties)) {
    if (value === null || value === undefined) continue;
    out[key] = typeof value === 'string' ? value : String(value);
  }
  return out;
}

function getToken(): string | null {
  return process.env.HUBSPOT_PRIVATE_APP_TOKEN?.trim() || null;
}

/** HubSpot date properties require midnight UTC in milliseconds */
function toHubSpotDate(isoString: string): number {
  const d = new Date(isoString);
  const midnightUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return midnightUtc;
}

function getHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

// ---------------------------------------------------------------------------
// Auto-create property group + properties (idempotent)
// ---------------------------------------------------------------------------

let _bootstrapped = false;

async function ensurePropertiesExist(token: string): Promise<void> {
  if (_bootstrapped) return;

  const headers = getHeaders(token);

  // 1. Ensure property group exists
  const groupRes = await fetch(
    `${HUBSPOT_API_BASE}/crm/v3/properties/contacts/groups/${PROPERTY_GROUP}`,
    { headers },
  );

  if (groupRes.status === 404) {
    console.log('[hubspot] Creating property group:', PROPERTY_GROUP_LABEL);
    const createGroupRes = await fetch(
      `${HUBSPOT_API_BASE}/crm/v3/properties/contacts/groups`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: PROPERTY_GROUP,
          label: PROPERTY_GROUP_LABEL,
          displayOrder: -1,
        }),
      },
    );
    if (!createGroupRes.ok && createGroupRes.status !== 409) {
      const body = await createGroupRes.text();
      console.error(`[hubspot] Failed to create property group (${createGroupRes.status}): ${body}`);
    }
  }

  // 2. Fetch existing properties to see which ones we need to create
  const existingRes = await fetch(
    `${HUBSPOT_API_BASE}/crm/v3/properties/contacts`,
    { headers },
  );

  const existingNames = new Set<string>();
  if (existingRes.ok) {
    const data = (await existingRes.json()) as { results?: Array<{ name: string }> };
    for (const prop of data.results ?? []) {
      existingNames.add(prop.name);
    }
  }

  // 3. Create any missing properties
  for (const def of AEO_PROPERTY_DEFINITIONS) {
    if (existingNames.has(def.name)) continue;

    console.log('[hubspot] Creating property:', def.name);
    const createRes = await fetch(
      `${HUBSPOT_API_BASE}/crm/v3/properties/contacts`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: def.name,
          label: def.label,
          type: def.type,
          fieldType: def.fieldType,
          description: def.description,
          groupName: PROPERTY_GROUP,
          formField: false,
        }),
      },
    );

    if (!createRes.ok && createRes.status !== 409) {
      const body = await createRes.text();
      console.error(`[hubspot] Failed to create property ${def.name} (${createRes.status}): ${body}`);
    }
  }

  _bootstrapped = true;
  console.log('[hubspot] Property bootstrap complete');
}

// ---------------------------------------------------------------------------
// Core upsert (search-then-create/update)
// ---------------------------------------------------------------------------

/**
 * Standard HubSpot properties this integration will FILL when blank but never REPLACE.
 *
 * The audit gate collects a name and an email from whoever is reading a report. That is
 * not authority to rewrite a contact record: a customer who runs the free audit out of
 * curiosity used to have their lifecycle stage reset to `lead` and their `website`
 * replaced with whatever domain they happened to audit, and anyone who knew a contact's
 * address could do the same deliberately through a public endpoint.
 *
 * Filling a blank is still useful — that is what makes the integration worth having —
 * so the rule is fill, never overwrite. See docs/audit/03-hubspot.md H1 and M1.
 */
const FILL_IF_EMPTY = ['firstname', 'lastname', 'website', 'lifecyclestage'] as const;

type FillIfEmptyKey = (typeof FILL_IF_EMPTY)[number];

function isBlank(value: string | undefined | null): boolean {
  return value === undefined || value === null || value.trim() === '';
}

export async function upsertContact(
  email: string,
  properties: HubSpotContactProperties = {},
  fillIfEmpty: Partial<Record<FillIfEmptyKey, string>> = {},
): Promise<HubSpotContactResponse | null> {
  const token = getToken();
  if (!token) {
    console.warn('[hubspot] HUBSPOT_PRIVATE_APP_TOKEN not set; skipping upsertContact');
    return null;
  }

  if (!email) {
    console.warn('[hubspot] upsertContact called without email; skipping');
    return null;
  }

  // Auto-create properties on first call
  try {
    await ensurePropertiesExist(token);
  } catch (err) {
    console.error('[hubspot] Property bootstrap failed (continuing with upsert):', err);
  }

  const headers = getHeaders(token);
  const normalized = normalizeProperties(email, properties);

  // Search for existing contact by email
  const searchRes = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/contacts/search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [{ propertyName: 'email', operator: 'EQ', value: email }],
        },
      ],
      properties: ['email', ...FILL_IF_EMPTY],
      limit: 1,
    }),
  });

  if (!searchRes.ok) {
    const body = await searchRes.text();
    console.error(`[hubspot] search failed (${searchRes.status}): ${body}`);
    return null;
  }

  const searchData = (await searchRes.json()) as {
    results?: Array<{ id: string; properties?: Record<string, string | null> }>;
  };
  const existing = searchData.results?.[0];
  const existingId = existing?.id;

  if (existingId) {
    /* An existing contact keeps every field it already has. Only the aeo_* properties,
       which belong to this integration, are written unconditionally. */
    const patch: Record<string, string> = { ...normalized };
    const current = existing?.properties;
    const skipped: string[] = [];

    /* No properties in the search response means we cannot tell a blank field from a
       populated one. Filling on that assumption is exactly the overwrite this change
       exists to prevent, so when we cannot see, we do not write. */
    if (!current) {
      console.warn(
        `[hubspot] contact ${existingId}: search returned no properties; leaving standard fields untouched`,
      );
    } else {
      for (const key of FILL_IF_EMPTY) {
        const incoming = fillIfEmpty[key];
        if (!incoming) continue;
        if (isBlank(current[key])) {
          patch[key] = incoming;
        } else {
          skipped.push(key);
        }
      }
    }

    if (skipped.length > 0) {
      console.log(
        `[hubspot] contact ${existingId}: kept existing ${skipped.join(', ')} rather than overwriting`,
      );
    }

    const updateRes = await fetch(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${existingId}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ properties: patch }),
      },
    );
    if (!updateRes.ok) {
      const body = await updateRes.text();
      console.error(`[hubspot] update failed (${updateRes.status}): ${body}`);
      return null;
    }
    return (await updateRes.json()) as HubSpotContactResponse;
  }

  /* Nothing to preserve on a contact that does not exist yet. */
  const createRes = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/contacts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ properties: { ...normalized, ...fillIfEmpty } }),
  });

  if (!createRes.ok) {
    const body = await createRes.text();
    console.error(`[hubspot] create failed (${createRes.status}): ${body}`);
    return null;
  }

  return (await createRes.json()) as HubSpotContactResponse;
}

// ---------------------------------------------------------------------------
// AEO-specific upsert — called from the unlock route
// ---------------------------------------------------------------------------

export async function syncAeoLead(payload: AeoLeadPayload): Promise<HubSpotContactResponse | null> {
  const { firstName, lastName } = splitName(payload.fullName);

  /* Standard HubSpot fields: offered, not imposed. upsertContact writes these only
     when the contact is new or the field is empty. */
  const fillIfEmpty = {
    firstname: firstName,
    lastname: lastName,
    website: payload.auditedDomain,
    lifecyclestage: 'lead',
  };

  const properties: HubSpotContactProperties = {
    // Custom AEO properties (auto-created by ensurePropertiesExist)
    aeo_overall_score: payload.overallScore,
    aeo_overall_grade: payload.overallGrade,
    aeo_audit_url: payload.auditReportUrl,
    aeo_answerability_score: payload.answerabilityScore,
    aeo_structure_score: payload.structureScore,
    aeo_trust_score: payload.trustScore,
    aeo_freshness_score: payload.freshnessScore,
    aeo_schema_score: payload.schemaScore,
    aeo_engines_cited: payload.enginesCited.join(', ') || 'None',
    aeo_engines_missing: payload.enginesMissing.join(', ') || 'None',
    aeo_citation_rate: payload.citationRate,
    aeo_top_weakness: payload.topWeakness,
    aeo_audit_date: toHubSpotDate(payload.auditDate),
    aeo_lead_source: 'AEO Auditor',
  };

  console.log('[hubspot] Syncing AEO lead:', payload.email, {
    score: payload.overallScore,
    grade: payload.overallGrade,
    cited: payload.enginesCited,
    missing: payload.enginesMissing,
  });

  return upsertContact(payload.email, properties, fillIfEmpty);
}
