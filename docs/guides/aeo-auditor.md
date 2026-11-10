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

## The gate (`AEO_GATE_MODE`)
| Mode | What happens |
|---|---|
| unset / `off` | Today's behaviour. Only `AEO_AUDITS_PAUSED=true` refuses anything. |
| `observe` | Every rule is checked and logged as `[gate] observe would-refuse <CODE>`, together with `[gate] observe count <n>` (today's audits). Nothing is refused. |
| `enforce` | The rules refuse: a full report, the print view and custom questions need the unlock cookie; unlocks need a finished audit; new audits stop at the daily cap. |

Settings, all in Vercel → project → Settings → Environment Variables (the owner sets them):

| Name | Purpose |
|---|---|
| `AEO_GATE_MODE` | `off` / `observe` / `enforce` |
| `AEO_UNLOCK_COOKIE_SECRET` | Signs the per-audit unlock cookie. Without it, `enforce` refuses new audits (fails closed). |
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

## Rolling out
1. Set `AEO_GATE_MODE=observe`, the cookie secret and the cap on Production, then redeploy.
2. After about a week, compare the `would-refuse` lines with real leads.
3. With the owner's go, set `enforce`. To roll back, set `off`.

## Previews
Previews share the production database and HubSpot unless they have been given their own.
Don't submit the audit or unlock forms on a preview.
