# AEO Auditor: guide for CC staff

## What it does
1. A visitor enters a domain on aeo.campaigncreators.com and clicks **Audit my site**.
2. The app crawls the site: robots.txt, the sitemap, then up to 200 pages, all inside one
   time budget.
3. It writes buyer questions for that business and asks ChatGPT, Perplexity, Google AI and
   Claude, noting whether each answer names the site.
4. It scores five content checks (crawlability, schema, authority, topical depth, freshness)
   plus the AI citation rate, and shows the report with an overall score and grade.
5. Below the score, the report asks for a name and work email. Unlocking stores a lead in
   Supabase and syncs it to HubSpot, filling blank fields only.
6. After unlocking, the visitor can test up to three questions of their own, once per audit.

An engine whose key is missing, or which fails every question, is left out of the citation
rate and shows as "coming soon" or "unavailable". It never counts as "not cited".

## Report access (`AEO_REPORT_GATE`)
On by default. Without the per-audit unlock cookie, the report page, the status API and the
print view send only the preview (overall score and grade, date, AI citation count; the
status API also sends up to three short preview tips), and custom questions are refused. An unlock is accepted only for a finished audit with results,
only with a real-looking work email (reserved example and test domains are refused), and
writes nothing new when the same email unlocks the same audit again. One audit accepts at
most five different emails. Staff unlock without the form (signed in, on
`AEO_STAFF_EMAILS`); their unlock lasts the browser session. Anyone else who opens a report
link, a CC rep from the CRM included, sees the preview until they unlock.

| Value | What happens |
|---|---|
| unset / `enforce` / anything else | The rules above apply. |
| `observe` | The rules are logged as `[gate] observe would-refuse REPORT_LOCKED` or `UNLOCK_NOT_READY`, and nothing is refused. |
| `off` | Everyone gets the full report. The off switch, for an emergency. |

The cookie is signed with `AEO_UNLOCK_COOKIE_SECRET` when it is set, otherwise with a key
derived from the server's database key. Changing either key asks visitors to unlock again.

## The run gate (`AEO_GATE_MODE`)
| Mode | What happens |
|---|---|
| unset / `off` | Only `AEO_AUDITS_PAUSED=true` refuses anything. |
| `observe` | Every rule is checked and logged as `[gate] observe would-refuse <CODE>`, together with `[gate] observe count <n>` (today's audits). Nothing is refused. |
| `enforce` | The rules refuse: new audits stop at the daily cap, on previews that share the database, and when required settings are missing. |

Settings, all in Vercel → project → Settings → Environment Variables (the owner sets them):

| Name | Purpose |
|---|---|
| `AEO_REPORT_GATE` | Report access: `enforce` (default) / `observe` / `off` |
| `AEO_GATE_MODE` | Run gate: `off` (default) / `observe` / `enforce` |
| `AEO_UNLOCK_COOKIE_SECRET` | Optional. Signs the per-audit unlock cookie; without it a derived key is used. |
| `AEO_DAILY_AUDIT_CAP` | Audits per UTC day. Without it, `enforce` refuses new audits. |
| `AEO_PREVIEW_DB_ISOLATED` | `true` only when a preview has its own database. Otherwise `enforce` refuses audits on previews. |
| `AEO_AUDITS_PAUSED` | `true` stops new audits and custom questions in every mode. |
| `AEO_PUBLIC_ACCESS` | `staff_only` refuses every public audit. Never set it on production. |
| `AEO_HUBSPOT_SYNC` | `off` stores leads without syncing them to HubSpot (for test environments). |
| `NEXT_PUBLIC_AEO_GUIDE` | `on` shows the first-visit guide and the Tutorials button on the report. Needs a redeploy. |

Refusal codes in the logs: `PAUSED`, `CONFIG_MISSING`, `PREVIEW_SHARED_DB`, `STAFF_ONLY`,
`DAILY_CAP`, `REPORT_LOCKED`, `UNLOCK_NOT_READY`.

## Checking a setup
- `npm run gate:check`, in a shell with the environment loaded, prints each name as
  present or absent and the mode. It never prints a value.
- Vercel → project → Logs, then search for `[gate]`.

## Rolling out the run gate
1. Set `AEO_GATE_MODE=observe` and the cap on Production, then redeploy.
2. After about a week, compare the `would-refuse` lines with real leads.
3. With the owner's go, set `enforce`. To roll back, set `off`.

## Previews
Previews share the production database and HubSpot unless they have been given their own.
Don't submit the audit or unlock forms on a preview.
