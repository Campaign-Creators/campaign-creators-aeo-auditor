---
paths:
  - "src/lib/auditor/**"
  - "src/lib/inngest/functions.ts"
  - "src/lib/scoring.ts"
  - "src/lib/types.ts"
---

# Scoring & AI-probe pipeline rules

This repo has two independent audit pipelines that score differently. Before
changing any weight, check, or probe, identify which pipeline you're in:

- **Sync pipeline** (`src/lib/auditor/index.ts` + `src/lib/auditor/checks/*.ts`,
  triggered by `POST /api/audit`): weights come from `CHECK_WEIGHTS` in
  `src/lib/types.ts` — AI Citation 40%, Crawlability 20%, Content 20%,
  Schema 10%, Authority 10%. In-memory only, no Supabase writes.
- **Async pipeline** (`src/lib/inngest/functions.ts`, triggered by
  `POST /api/audit/start` via the Inngest `audit/requested` event): this is
  the pipeline behind aeo.campaigncreators.com. Its overall-score formula is
  hardcoded inline in `functions.ts` (`store-results` step) — 40% AI citation
  plus 12% each across answerability/brevity/trust/structure/freshness. It
  does **not** use `CHECK_WEIGHTS` or `computeOverallScore`.
- `computeOverallScore` in `src/lib/scoring.ts` is unused dead weight — its
  return value (`RunScorersResult.overall_score`) is computed but never read;
  `functions.ts` recomputes the overall score itself. Don't "fix" its weights
  expecting it to affect production output.

Never edit a weight in one pipeline assuming it applies to the other. If a
change is meant to affect production scoring, it belongs in
`src/lib/inngest/functions.ts`, not `src/lib/scoring.ts` or `src/lib/types.ts`.

`probeGoogleAI` (`src/lib/auditor/ai-probe.ts`) returning 0/10 citations is a
known SerpAPI limitation (AI Overviews aren't triggering for these queries),
not a bug in this codebase — don't "fix" it by loosening citation-matching
logic without checking `[Google probe]` debug logs first.

`MAX_PAGES = 200` in `src/lib/inngest/functions.ts` is an intentional crawl
cap, not a bug — large sites get partial audits by design.
