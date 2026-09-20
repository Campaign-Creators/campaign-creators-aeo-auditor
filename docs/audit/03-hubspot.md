# A3 — HubSpot integration map

**Audit item:** A3 — unprompted in the meeting; added because a live integration feeds real leads into HubSpot and nobody had mapped it before touching anything near the leads table.
**Date:** 2026-09-20
**Author:** RJ (Razel De Jesus), with Claude Code
**Method:** code read at `main@f9dd267`, the repo's own `docs/hubspot-setup.md`, and read-only analysis of the 181 stored leads. **No call was made to the HubSpot API** — the token exists only in Vercel, and writing to a live CRM is not something an audit should do.
**Deliverable:** a map plus findings. Nothing has been fixed.

---

## 1. The map

### Where it runs and what triggers it

```
Visitor sees a gated report → enters name + email
  └─ POST /api/audit/<auditId>/unlock      ← unauthenticated, unthrottled, no captcha
       ├─ upsert into Supabase `leads`  (onConflict: email,audit_request_id)
       ├─ touch audit_requests.updated_at
       └─ syncAeoLead(payload)                     lib/hubspot.ts:293
            └─ upsertContact(email, properties)    lib/hubspot.ts:208
                 ├─ ensurePropertiesExist()  — once per warm instance, creates the
                 │    "AEO Audit Data" group + 14 custom properties if absent
                 ├─ POST /crm/v3/objects/contacts/search   (filter: email EQ)
                 ├─ found    → PATCH /crm/v3/objects/contacts/<id>
                 └─ not found→ POST /crm/v3/objects/contacts
```

It runs **in-request**, not in the background: despite the "fire-and-forget" comment at
[unlock/route.ts:117-118](../../src/app/api/audit/%5BauditId%5D/unlock/route.ts#L117), the call is
awaited ([:175](../../src/app/api/audit/%5BauditId%5D/unlock/route.ts#L175)) so the platform does not
kill the function mid-call. The visitor waits for HubSpot. There is no queue and no retry.

### What it writes

| HubSpot property | Source | Note |
|---|---|---|
| `email` | the gate form | the match key |
| `firstname` / `lastname` | the gate form, split on first space | **overwrites** existing values |
| `website` | `audit_requests.url` — the audited domain | **overwrites**; may not be the contact's own site |
| `lifecyclestage` | constant `'lead'` | **overwrites** — see H1 |
| `aeo_overall_score` / `_grade` | `audit_results` | the A2 numbers |
| `aeo_answerability_score` | `answerability_score` | labelled "AEO Crawlability Score" in HubSpot — the label is more accurate than the app's own UI |
| `aeo_structure_score`, `aeo_trust_score`, `aeo_freshness_score` | `audit_results` | freshness is always 0 |
| `aeo_schema_score` | `brevity_score` column | the column-name swap from A2 is unwound correctly here |
| `aeo_engines_cited` / `_missing` | derived per engine from `raw_findings.aiProbe` | "None" when empty |
| `aeo_citation_rate` | `"<cited>/<total>"` | `"0/0"` when the probe did not run |
| `aeo_top_weakness` | lowest-scoring dimension | **"Freshness" for 266 of 290 audits** — see H4 |
| `aeo_audit_date` | `audit_requests.created_at`, floored to midnight UTC | |
| `aeo_lead_source` | constant `'AEO Auditor'` | |

`hs_lead_status` is listed in `docs/hubspot-setup.md` §4 but **is not set by the code**.

### What happens on failure

| Failure | Behaviour |
|---|---|
| Token missing | Warn to console, sync skipped, request still returns `{success:true}` |
| HubSpot search/create/update non-2xx | Logged to console, `null` returned, request still succeeds |
| Any throw in sync | Caught at [unlock/route.ts:177](../../src/app/api/audit/%5BauditId%5D/unlock/route.ts#L177), request still succeeds |
| Supabase lead insert fails | Logged, **and the HubSpot sync still runs** |
| Audit has no results row | Sync skipped entirely with a console warning ([:180-182](../../src/app/api/audit/%5BauditId%5D/unlock/route.ts#L180)) |

In every case the visitor sees success and nothing is recorded anywhere queryable. **Measured: 0 of
181 leads hit the no-results skip branch**, so that path has not bitten in production.

### Is it idempotent?

Partly, and the distinction matters:

- **Contact creation:** yes. Search-by-email before create means repeat unlocks do not duplicate contacts.
- **Property bootstrap:** yes. It reads existing properties, creates only what is missing, and tolerates 409.
- **Lead rows:** yes. The Supabase upsert keys on `(email, audit_request_id)`, matching the unique constraint from migration `004`.
- **Property values:** **no.** Every unlock overwrites the previous AEO values on that contact. One contact carries exactly one audit's worth of data — the most recent one. 7 audits already have more than one lead attached.

---

## 2. Findings, ranked

### H1 — HIGH. A public, unauthenticated endpoint can overwrite existing HubSpot contacts

`/api/audit/<auditId>/unlock` has no authentication, no rate limit, no captcha, and no check that the
caller has anything to do with the audit. It accepts any name and any email, and `upsertContact`
matches on email and **PATCHes whatever contact comes back**
([hubspot.ts:234-268](../../src/lib/hubspot.ts#L234)).

So for any email address already in Campaign Creators' HubSpot, a stranger can overwrite:

- `firstname` and `lastname` — free text from the form
- `website` — whatever domain they chose to audit
- `lifecyclestage` — forced to `'lead'` ([hubspot.ts:301](../../src/lib/hubspot.ts#L301))

The path is: create an audit via `/api/audit/start` (rate limited to 5/hour/IP), then POST that
auditId to `/unlock` with the victim's email — the unlock call itself is unlimited, so one audit can
be re-unlocked with any number of addresses.

**The lifecycle-stage part is the one to check first.** An existing *customer* who runs a free audit
is PATCHed with `lifecyclestage: 'lead'`. Whether HubSpot actually applies that downgrade depends on
the portal's lifecycle-stage settings, which I cannot see from here — **this is verifiable in
HubSpot in a few minutes** by opening any known customer contact who has run an audit and reading
the property history. Do that before deciding how urgent this is.

### H2 — HIGH. Preview deployments write to the real CRM

`HUBSPOT_PRIVATE_APP_TOKEN` is scoped to **preview and production** in Vercel, and preview also uses
the production Supabase project (B1 §6, S1). Any preview deployment of any PR that exercises the
unlock flow creates real contacts in the real HubSpot and real rows in the real `leads` table.

There is no test portal and no environment in which this integration can be exercised safely.

### H3 — HIGH. Nothing records whether a lead reached HubSpot

The `leads` table is `id, audit_request_id, email, created_at, name`. There is no HubSpot contact id,
no sync status, no sync timestamp, and no error column. Sync outcomes go to `console.log`/`console.error`
only ([unlock/route.ts:176-178](../../src/app/api/audit/%5BauditId%5D/unlock/route.ts#L176)).

Consequences, in order of how much they will hurt:

- "Did all 181 leads reach HubSpot?" cannot be answered from the database. It can only be
  reconstructed by exporting HubSpot contacts and diffing against `leads` by email.
- A failed sync is unreplayable — there is no queue, no retry, and no record to retry from.
- If the token is ever rotated, revoked, or rate-limited, leads keep being captured and silently not
  synced, and the first signal will be a salesperson noticing an empty pipeline.

### H4 — HIGH. The CRM is being populated with numbers that do not reproduce, and one that is a constant

Everything under `aeo_*` inherits the A2 findings: the overall score is dominated by a citation rate
computed by substring matching, and **31 of 58 same-day re-audits produced a different score, 8 a
different letter grade**. Sales conversations are therefore built on a snapshot that a re-run will
not reproduce, stored in a CRM field that reads as a fact about the prospect.

The sharpest case is `aeo_top_weakness`, which sales would naturally use as the opener. It picks the
lowest-scoring dimension ([unlock/route.ts:31-47](../../src/app/api/audit/%5BauditId%5D/unlock/route.ts#L31)),
and freshness is hardcoded to 0 (A1-F1). Replaying the rule over all 290 stored results:

| Value written to `aeo_top_weakness` | Audits |
|---|---|
| **Freshness** | **266** |
| Content Structure | 19 |
| AI Crawlability | 5 |

92% of leads carry the same "top weakness", and it is the dimension the tool never measured.

### H5 — MEDIUM. One contact holds one audit; the previous one is overwritten

The AEO properties are flat fields on the contact, so a prospect who audits a second domain replaces
the first domain's scores, grade, report URL and `website`. There is no timeline event, no note, and
no custom object — so the CRM cannot show "this prospect has audited three sites", which is
precisely the signal a salesperson would want.

This also interacts with H1: a second person unlocking the same report with the same email
overwrites the first person's name on that contact.

### M1 — MEDIUM. `website` may not be the contact's website

The audited domain is written to HubSpot's standard `website` property
([hubspot.ts:300](../../src/lib/hubspot.ts#L300)). An agency auditing a client's site, a consultant
auditing a prospect, or anyone auditing a competitor all overwrite their own `website` value with
someone else's domain. That property feeds company association and list segmentation.

### M2 — MEDIUM. The setup doc has drifted from the code

`docs/hubspot-setup.md` is unusually good for this repo, which is why the three gaps are worth naming:

1. §4 says `hs_lead_status` is set to "NEW". The code never sets it.
2. §5 says the sync is "(async, non-blocking)". It is awaited; the visitor waits for it.
3. §7 references an `aeo-hubspot-card/` project for a CRM card. **That directory does not exist in
   this repo and never has** (no commit in any branch touches it). Either it lives somewhere nobody
   has inventoried, or it was never built. Worth one question to Frank before anyone goes looking.

### M3 — MEDIUM. No consent is captured, and there is no privacy policy in the app

The gate collects name and email under the line *"We respect your privacy. No spam, ever."*
([AuditResultPage.tsx:666](../../src/components/aeo/AuditResultPage.tsx#L666)) and the address is
pushed into a marketing CRM as `lifecyclestage: lead`. There is no consent checkbox, no mention of
CRM storage, and no `/privacy` or `/terms` route in the application.

**This is a question for Bob and whoever owns marketing compliance, not an engineering defect** — but
it belongs in this report because the engineering choice (push straight to CRM, no consent field)
is what forecloses the options.

### L1 — LOW. Small things

- The property bootstrap reads `/crm/v3/properties/contacts` without following pagination
  ([hubspot.ts:159](../../src/lib/hubspot.ts#L159)). In a portal with enough properties, existing
  ones could fall outside the first page and be re-created; 409 is tolerated, so the effect is noise
  rather than damage.
- `aeo_citation_rate` is written as `"0/0"` when the probe did not run, and all four engines land in
  `aeo_engines_missing`. In the CRM that reads as "no AI engine cites them" rather than "not
  measured" — the same conflation A2-G5 describes, arriving in the place sales actually reads.
- No ownership check ties a lead to its audit; any valid auditId accepts any email.

---

## 3. What works

- **Search-then-upsert is the right shape.** Contacts are not duplicated, and the property bootstrap
  is genuinely idempotent — it checks what exists, creates only what is missing, and treats 409 as
  success.
- **A HubSpot failure never breaks the visitor's unlock.** Every call is wrapped; the report opens
  regardless. For a lead-gen tool that is the correct priority.
- **The sync is awaited deliberately**, with a comment explaining why — this was a real bug someone
  already found and fixed.
- **The lead row is written before the sync**, so Supabase is the system of record for capture even
  when HubSpot fails. Combined with the unique constraint, `leads` is the reliable half of this
  integration.
- **`docs/hubspot-setup.md` exists**, is specific about scopes and properties, and was accurate on
  every point I could check from the code except the three in M2. That is better documentation than
  the scoring logic has.

## 4. What could not be verified

| Item | Why | How to close it |
|---|---|---|
| Whether the lifecycle-stage downgrade actually applies (H1) | Portal setting, not visible in code | Open a customer contact in HubSpot who has run an audit; read property history |
| How many of the 181 leads exist as HubSpot contacts | No token locally, and I did not call the API | Export contacts filtered on `aeo_lead_source = "AEO Auditor"`, diff against `leads` by email |
| Whether any contact has been overwritten in the wild | Same | HubSpot property history on a sample of contacts |
| Whether the 14 auto-created properties exist as documented | Same | HubSpot → Settings → Properties → "AEO Audit Data" group |
| Where `aeo-hubspot-card/` lives | Not in this repo | Ask Frank |

I deliberately did not pull the token from Vercel to answer these. All five are read-only lookups a
person with HubSpot access can do faster than I can, and none of them requires code.

## 5. Before anyone touches the leads table

This was the reason A3 exists, so it gets its own section.

| If you change… | What breaks |
|---|---|
| The unique constraint on `(email, audit_request_id)` | The upsert at [unlock/route.ts:91-98](../../src/app/api/audit/%5BauditId%5D/unlock/route.ts#L91) silently becomes an insert → duplicate lead rows → one duplicate PATCH to HubSpot per duplicate |
| `leads.email` or `leads.name` | The gate write path; HubSpot itself reads neither column — it uses the request body |
| `audit_results` column names | The HubSpot payload maps them directly at [unlock/route.ts:159-170](../../src/app/api/audit/%5BauditId%5D/unlock/route.ts#L159); renaming `brevity_score` without updating this file sends `0` as the schema score |
| `audit_requests.url` or `created_at` | Feed `website` and `aeo_audit_date` |
| Anything the `audit_overview` view selects | That view joins `leads` and is not defined in any migration (B1 §5.1); something outside this repo reads it |

The safe order for any leads-table work is: confirm what consumes `audit_overview` first, keep the
unique constraint, and change `audit_results` column names and `unlock/route.ts` in the same commit.

## 6. Reproducing the measurements

- Lead coverage: every `leads.audit_request_id` was checked against `audit_results` — 0 orphans.
- `aeo_top_weakness` distribution: `findTopWeakness` re-implemented exactly as written and replayed
  over the stored dimension scores of all 290 results.
- Repeat unlocks: `leads` grouped by `audit_request_id` — 7 audits with more than one lead.
- Everything else in this document is from the source files cited, not from the HubSpot API.
