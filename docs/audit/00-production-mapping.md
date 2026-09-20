# B1 — Production mapping, repo inventory, and provisioning observations

**Audit item:** B1 (production repo), B2 (production Supabase), B3 (Nexus provisioning)
**Date:** 2026-09-20
**Author:** RJ (Razel De Jesus), with Claude Code
**Status:** B1 resolved. B2 resolved with one naming caveat. B3 observed and reported, not remediated.
**Unexpected finding:** the committed migrations do not describe the live database — see §5.1.
**Secrets:** none in this document. Variable names and public identifiers only.

---

## 1. The answer

```
aeo.campaigncreators.com                       verified custom domain, HTTP 200, served by Vercel
  └─ Vercel project   campaign-creators-aeo-auditor
       id             prj_MAsnlxLyIU68qbVLf17EdZuyHYvG
       team           Fraink Anderson's projects  (team_Iad90Q1vJG0LTID1N20zM30r)
       created        2026-05-27 09:02 UTC
     └─ GitHub repo   id 1250927799  =  Campaign-Creators/campaign-creators-aeo-auditor
          production branch   main
          live deployment     f9dd267  (2026-07-16, "fix: scrambled page 2 when saving the report as PDF")
        └─ Supabase   jsknpmrtelphqfiniuyh
             NEXT_PUBLIC_SUPABASE_URL is ONE env entry covering production, preview and development
```

Both halves of the guess that started this were right: the unsuffixed repo is production, and
`jsknpmrtelphqfiniuyh` is the production database. What nobody had was the evidence chain, which is
what B1 asked to be recorded permanently. It is above, and it is reproducible from §2.

Second domain on the same project: `campaign-creators-aeo-auditor.vercel.app` (also verified).

## 2. How this was established

Working backwards from the deployed site, per B1's suggested approach. Anyone can re-run these.

| Link in the chain | Evidence |
|---|---|
| Domain is live and on Vercel | `curl -sI https://aeo.campaigncreators.com/` → `HTTP 200`, `Server: Vercel` |
| Domain → Vercel project | Vercel API `GET /v9/projects/prj_MAsnlxLyIU68qbVLf17EdZuyHYvG/domains` lists `aeo.campaigncreators.com`, verified |
| Vercel project → GitHub repo | Project `link.repoId` = `1250927799` |
| repoId → the org repo | `gh api repos/Campaign-Creators/campaign-creators-aeo-auditor` → `id: 1250927799` |
| Branch | `link.productionBranch` = `main`; latest production deployment `meta.githubCommitRef` = `main`, sha `f9dd267` |
| Repo → Supabase | Vercel env `NEXT_PUBLIC_SUPABASE_URL` = `https://jsknpmrtelphqfiniuyh.supabase.co`, targets production + preview + development |
| Supabase is the live one | `leads` = 181 rows, `audit_requests` = 304, most recent request 2026-09-14 |

Two mechanical notes for whoever repeats this:

- The `vercel` CLI defaults to the personal scope and answers `project_not_found`. Pass
  `--scope team_Iad90Q1vJG0LTID1N20zM30r`.
- The CLI's auth token is at `%APPDATA%/com.vercel.cli/Data/auth.json` — note the `Data` segment;
  the path without it does not exist.

## 3. The trap: Vercel reports the wrong repo owner

Vercel's stored project link reads:

```
"link": { "type": "github", "org": "frainkanderson23", "repo": "campaign-creators-aeo-auditor",
          "repoId": 1250927799, "productionBranch": "main" }
```

`frainkanderson23/campaign-creators-aeo-auditor` **does not exist** as a separate repo. The
repository was transferred into the `Campaign-Creators` org and Vercel kept the owner name it was
linked under; `repoId` is the stable identifier and it matches the org repo exactly. The GitHub API
redirects the old path to the new one, which is why both spellings appear to work.

Anyone checking the Vercel dashboard will read "frainkanderson23" and conclude production deploys
from a personal fork. It does not. **Always compare `repoId`, never the owner string.**

## 4. Repo inventory — four AEO repos, one real

RJ's count of four was correct; Bob saw two. All four are in the `Campaign-Creators` org.

| Repo | Size | Commits | Span | `supabase/` | Vercel project | Verdict |
|---|---|---|---|---|---|---|
| `campaign-creators-aeo-auditor` | 693 KB | ongoing to 2026-07-16 | 2026-05-27 → 2026-07-16 | 4 migrations | **yes, live** | **Production** |
| `campaign-creators-aeo-auditor-2` | 70 KB | 54 | 2026-05-27 only | none | none | Abandoned scaffold |
| `campaign-creators-aeo-auditor-3` | 55 KB | 39 | 2026-05-27 only | none | none | Abandoned scaffold |
| `campaign-creators-aeo-auditor-4` | 41 KB | 24 | 2026-05-27 only | none | none | Abandoned scaffold |

The three suffixed repos are the same scaffold stopped at different points. Each begins at
`Initial commit` and ends at the identical commit `feat: foundation src/lib/motion-config.ts`, all
within 2026-05-27, with byte-identical top-level file listings and a single `main` branch. Their
`.vercel.app` hostnames return **HTTP 404** — `-3`'s GitHub `homepage` field points at a deployment
that does not exist, so that field is aspirational, not evidence.

None of them contains a `supabase/` directory, and none commits a real Supabase project ref: all
three carry `.env.local.example` with placeholder values only.

> **This is not a recommendation to delete anything.** Per the handoff, repo and project cleanup is
> Bob's first pass. The inventory is here so that when he does it, he is deciding with facts.

### Naming collision worth stating plainly

Bob's "AEO Auditor 2" and "AEO Auditor 3" on the Sep 16 call were **Supabase project names**, not
these GitHub repos. The numbering does not correspond. Repo `-2` is an empty scaffold with no
database; the Supabase project Bob called "AEO Auditor 2" is the one with the leads in it. Treating
those two numbering schemes as the same thing is the likeliest way to lose another week.

## 5. B2 — the production Supabase project

`jsknpmrtelphqfiniuyh`. Tables and row counts, read via PostgREST with no writes:

| Table | Rows |
|---|---|
| `audit_requests` | 304 |
| `audit_rate_limits` | 304 |
| `audit_results` | 290 |
| `leads` | 181 |
| `profiles` | 0 |
| `audit_overview` | 311 |
| `_handle_new_user_errors` | — |

Activity window: first request 2026-05-28, most recent 2026-09-14. The tool is in active use.

`audit_overview` presents `audit_requests` joined to `leads` and `audit_results`
(`audit_id, url, status, audit_date, utm_*, name, email, overall_score, overall_grade,` and the
five dimension scores). Its 311 rows exceed `audit_requests`'s 304 by exactly 7, which is the
number of audit requests carrying more than one lead row — a one-to-many join, counted twice. No
application code references it; something outside this repo consumes it.

**`profiles` is empty**, which supports the handoff's suspicion that lead capture does not use
Supabase Auth. The single "Nexus QA bot" auth user Bob saw is consistent with a project whose auth
was provisioned and never used. The actual capture path is `src/app/api/audit/[auditId]/unlock/route.ts`,
which is also where the HubSpot call lives — that belongs to A3 and is not analysed here.

**Caveat, unresolved:** this project's *display name* in the Supabase dashboard is not verified.
Confirming it reads "AEO Auditor 2" closes B2 completely and takes one glance at the dashboard.

### 5.1 The repo's migrations do not describe the live database

B1 asks for the repo's Supabase configuration to be cross-checked against the real project. It does
not match. `supabase/migrations/` is four files, and the live schema has diverged from them in both
directions:

| Object | In `supabase/migrations/` | In the live database | Used by the app |
|---|---|---|---|
| `ip_rate_limit_log` | created by `001_initial_schema.sql` | **absent** (REST 404) | no |
| `audit_rate_limits` | **never created** | present, 304 rows | yes — `src/lib/rateLimit.ts` |
| `audit_overview` | **never created** | present, 311 rows | no — consumed externally |

So the live rate limiter runs against a table that exists in no committed migration, while the
table the migrations do create is not there at all. Someone applied changes through the Supabase
dashboard and never wrote them back. A fresh `supabase db push` into an empty project would produce
an application that cannot rate-limit and a reporting surface that does not exist.

**Consequence for this audit:** the migrations directory cannot be used as a description of
production. Anything A1 or A2 needs to know about the schema has to be read from the live database,
not from the repo. **[ANALYSIS]** Reconstructing the drift into a migration is worth doing, but it
is a change, so it waits for RJ.

## 6. B3 — Nexus provisioning, and what it left behind

Bob's description of Nexus — auto-provisions repo, Vercel project and Supabase instance, then wires
the env vars together — is corroborated:

- All four repos carry the same `.github/workflows/nexus-build.yml`.
- All four repos and the Vercel project were created on 2026-05-27.
- The production repo still has two agent-authored PRs open and unreviewed: #82 (2026-05-28) and
  #134 (2026-07-06).

### Security observations, ranked

Reported, not remediated. No cleanup attempted, per the handoff.

**S1 — HIGH. The production service-role key is available to preview and development deployments.**
`SUPABASE_SERVICE_ROLE_KEY` is scoped to all three Vercel targets, and all three point at the same
database (§1). Every preview deployment of every PR — including PRs opened automatically by the
Nexus agent — runs with credentials that bypass RLS on the live `leads` table. There is no
environment in which this application can be exercised without production write access.

**S2 — HIGH. `nexus-build.yml` grants a write-capable agent to anyone who can comment.**
The workflow triggers on any issue labelled `nexus-build` *or* any issue comment containing
`@claude`, and runs `anthropics/claude-code-action` with `--dangerously-skip-permissions` and
`contents: write`, `pull-requests: write`, `issues: write`. The repo is **public**. It then re-auths
git with a fresh token and auto-opens a PR. PRs #82 and #134 are what that looks like in practice.

*Operational consequence for this audit:* do not open issues in this repo and do not write `@claude`
in a comment on one. Either will start an agent that commits.

**S3 — MEDIUM. One database serves production, preview and development.** A local `npm run dev`
writes to the same `leads` and `audit_requests` tables the business reads. Any A1/A2 work that runs
the pipeline end to end will add rows to production unless it is deliberately read-only.

**S4 — MEDIUM, informational.** Credentials were distributed across an unknown number of projects by
an automated process with no inventory. Deleting a project does not rotate a key that was copied
elsewhere. Rotation, if it happens, has to be driven from the Supabase project's own key list, not
from project cleanup.

**Positive finding.** No credential is committed anywhere in the four repos: no `.env` file has ever
been added in the production repo's history (only `.env.example`), no JWT- or key-shaped string
appears in any tracked file at `HEAD`, and `.gitignore` covers `.env*`, `.env*.local` and `.vercel`.
The three scaffolds carry placeholders only.

## 7. Observations parked for A1 / A2

Noticed while counting rows. **Not conclusions** — they are starting points for the crawler and
grading audits, and neither has been investigated.

- `audit_requests` (304) exceeds `audit_results` (290) by **14**. Fourteen requests have no stored
  result. Whether that is in-flight records, crawl failures, or silent partial completion is exactly
  the A1 question: *what happens on failure?*
- **7 audit requests carry more than one lead row** (181 leads across 174 distinct
  `audit_request_id`s). Migration `004` constrains `UNIQUE (email, audit_request_id)`, so two
  *different* people unlocking the same report is legal and may be exactly what these are. Whether
  they are genuine second contacts or repeat submissions matters to A3, because each one is a
  HubSpot write.
- A separate defect in the grading path was found on 2026-09-17, before this handoff existed: when
  the AI probe does not run, the scorer dropped the `ai_citation` dimension — 40% of the grade —
  and averaged the remaining five, which *raises* the score. 23 of the 290 stored results took that
  path. A fix is written and tested on branch `fix/ai-probe-caveat`; it is **not** merged and not
  pushed, because under this handoff it is an A2 finding and RJ triages the fix separately.

## 8. What could not be verified

| Item | Why | Who can close it |
|---|---|---|
| Supabase dashboard project *names* ("AEO Auditor 2" / "3") | No dashboard access; refs are visible, display names are not | Bob or RJ, one glance |
| Whether other Supabase projects exist and what is in them | Same | Bob's first pass |
| Whether `AEO Auditor 3` (the Supabase project) holds storage, edge functions or a live app | Same. Its emptiness in one table proves nothing, as the handoff warns | Bob's first pass |
| Whether any AEO deployment exists outside the two Vercel scopes visible here | Only `Fraink Anderson's projects` and `razel-2646's projects` are reachable with current access | Vercel org admin |
| Whether `audit_overview` is a view or a table, and when the drift in §5.1 was applied | Needs catalog access (`information_schema`), which PostgREST does not expose | Supabase dashboard SQL editor |
| Who or what consumes `audit_overview` | No reference in this repo; candidates are the HubSpot integration, a dashboard export, or a manual report | A3, or Bob |
| HubSpot integration behaviour | Out of scope for B1; it is A3 | A3 |

## 9. Blocking / decisions needed before A1

1. **A production service-role key is present in the local clone** at `.env.local`, written by
   `vercel env pull`. It is gitignored and has been used read-only (row counts in §5). Ground rule 2
   says no service-role key in an environment engineering controls. Decide: delete it and work from
   the anon key, or keep it for read-only verification.
2. **A1 needs paid live runs.** The pipeline calls Anthropic, OpenAI, Perplexity and SerpAPI. A
   determinism check is two runs minimum of the same URL; a useful sample is six to eight across
   site types. The local clone currently holds only `ANTHROPIC_API_KEY`, so a full-fidelity run is
   not possible without pulling more production secrets locally — which conflicts with item 1.
   Recommended sequence: exhaust the 290 stored results and the code first, then request a specific,
   counted set of live runs.
3. **Confirm the Supabase project name** (§5 caveat) to close B2 formally.
