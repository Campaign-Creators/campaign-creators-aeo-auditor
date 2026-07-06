@AGENTS.md

# CLAUDE.md

AEO Auditor — see @README.md for generic `create-next-app` boilerplate notes (mostly unmodified).

## 1. Project overview

- **AEO Auditor** ("Answer Engine Optimization"): audits a domain's visibility to AI answer engines, scores it, and gates the full report behind an email capture. Live at aeo.campaigncreators.com.
- Two parallel audit pipelines exist in this codebase (see §5) — confirm which one you're editing before touching scoring or checks.
- Backed by Supabase (`audit_requests` / `audit_results` tables, migrations in `supabase/migrations/`) and Inngest for the background crawl job.
- Captured leads sync to HubSpot CRM; UTM params are captured at audit intake.
- Includes a PDF-exportable report page and a static sample report used for marketing.

## 2. Commands

- Dev server: `npm run dev`
- Production build (also CI's Gate 3 check — must pass before a PR can merge): `npm run build`
- Lint: `npm run lint` (flat ESLint config via `eslint-config-next`)
- Tests: `npm test` (vitest; only `src/**/*.test.ts` is collected)
- Type-check: no dedicated script exists — run `npx tsc --noEmit`

## 3. Architecture at a glance

- Next.js App Router under `src/app/`; path aliases `@/*` and `@/src/*` both resolve to `src/`.
- Two independent audit pipelines — do not conflate them:
  - **Sync / in-memory**: `POST /api/audit` → `src/lib/auditor/index.ts` runs `src/lib/auditor/checks/*.ts` against an in-memory `auditStore` (no persistence).
  - **Async / persisted (production)**: `POST /api/audit/start` → Inngest event `audit/requested` → `src/lib/inngest/functions.ts` crawls the site, runs the 4 AI probes, scores via `src/lib/scoring.ts`, and writes results to Supabase.
- AI engine probes live in `src/lib/auditor/ai-probe.ts`: Claude (`claude-sonnet-4-6`), ChatGPT (`gpt-4o`), Perplexity (`sonar`, base URL `https://api.perplexity.ai`), Google AI (via SerpAPI, `engine=google`, parsed from `ai_overview`/`answer_box`/`knowledge_graph`).
- HubSpot sync (`src/lib/hubspot.ts`) auto-creates an "AEO Audit Data" property group with 14 `aeo_*` custom contact properties on first lead sync — see `docs/hubspot-setup.md`.

## 4. Conventions

- Component styling uses CSS Modules (`*.module.css`) plus CSS custom properties defined in `src/app/globals.css` — never hard-code hex colors in components. See `.claude/rules/design-tokens.md`.
- Request bodies are validated with `zod` schemas defined inline in route handlers (e.g. `src/app/api/audit/start/route.ts`).
- Server-only secrets (Supabase service role key, HubSpot token, AI provider keys) are read directly from `process.env` inside `src/lib/*` and never exposed to the client; only `NEXT_PUBLIC_*` vars cross that boundary.

## 5. Critical gotchas

- **This is not the Next.js you know.** Read `node_modules/next/dist/docs/` before writing App Router code — APIs and conventions here diverge from training data (see @AGENTS.md).
- **Two scoring formulas, not one.** The AEO-first weights (AI Citation 40% / Crawlability 20% / Content 20% / Schema 10% / Authority 10%) are `CHECK_WEIGHTS` in `src/lib/types.ts`, used only by the sync `/api/audit` path. The production async pipeline (`src/lib/inngest/functions.ts`) instead computes `40% AI citation + 12% × 5 sub-scores` (including a freshness dimension the sync path lacks). `src/lib/scoring.ts`'s `computeOverallScore` (25/25/20/15/15) is dead code — its output is discarded and the score is recomputed inline in `functions.ts`. See `.claude/rules/scoring-pipeline.md`.
- **Google AI probe is known-broken, not regressed.** `probeGoogleAI` in `src/lib/auditor/ai-probe.ts` reliably returns 0/10 citations for commercial queries — SerpAPI isn't triggering AI Overviews for these prompts. Don't treat a 0 score from this probe alone as a bug you introduced.
- **Background crawl caps at 200 pages** (`MAX_PAGES` in `src/lib/inngest/functions.ts`) — audits of larger sites are intentionally partial.
- **Brand tokens live in `src/app/globals.css`, not in DESIGN_SYSTEM.md.** The design doc's documented palette (`--color-primary: #2563eb`, etc.) is a generic placeholder and does not match the actual CC brand implementation (`--color-dark-navy: #0C2237`, `--color-accent: #35FFD8`, Inter font). Follow `globals.css` tokens for color; DESIGN_SYSTEM.md still governs spacing/typography scale and component patterns.
