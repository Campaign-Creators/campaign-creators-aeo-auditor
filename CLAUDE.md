@AGENTS.md

# AEO Auditor

Campaign Creators' free AEO (answer engine optimisation) audit: a visitor enters a domain,
the app crawls it, asks four AI engines buyer questions, scores the site, and shows a report
that is unlocked with a name and work email (the lead goes to Supabase and HubSpot).
Production: aeo.campaigncreators.com (Vercel, deploys from `main`).

**This repository is public.** No secrets, customer data, or descriptions of unfixed
security issues in code, comments, tests, commits, PRs or docs. Use neutral wording.

## Commands
- `npm run dev`, `npm run build`, `npm run lint`
- `npx tsc --noEmit` and `npx vitest run` (CI runs both on every PR)
- `npm run gate:check`: which gate settings this shell has (names and present/absent only)

## Layout
- `src/app/api/audit/start` creates an audit and queues it (Inngest; `api/audit/crawl` is the fallback).
- `src/lib/inngest/functions.ts` runs the pipeline: crawl (`lib/auditor/crawl.ts`), AI probe
  (`lib/auditor/ai-probe.ts`), scoring (`lib/scoring.ts`), store.
- `src/app/audit/[auditId]` is the report; `.../pdf` the print view; `api/audit/[auditId]/*`
  are status, unlock and custom prompts.
- `src/lib/gate.ts` is the access and run gate. `src/lib/safeFetch.ts` is the only way the
  crawler fetches.
- `supabase/migrations/` (applied by hand, in order); `supabase/drafts/` are not applied.

## Rules
- The gate ships dark: `AEO_GATE_MODE` unset means off (today's behaviour); `observe` logs
  `[gate] observe ...` lines and refuses nothing; `enforce` refuses. Gate env values in
  Vercel are set by the owner, never by an agent.
- Previews use the production database and HubSpot (docs/deploy.md): never submit the
  audit or unlock forms on a preview. Tests mock every external service.
- Migrations alter in place: `IF NOT EXISTS`, no `DROP`.
- New logic is test-first; a test counts only if it fails with the change reverted.
- UI follows DESIGN_SYSTEM.md (tokens from `src/app/globals.css`), light theme only.

## Design System

This project has a design system defined in DESIGN_SYSTEM.md at the repo root. ALL UI code MUST follow the design tokens, component patterns, and anti-patterns defined there. Do NOT use default Tailwind colors, spacing, or component styles — use the custom properties and class patterns from DESIGN_SYSTEM.md.

Violations of the design system are blocked at QA.
