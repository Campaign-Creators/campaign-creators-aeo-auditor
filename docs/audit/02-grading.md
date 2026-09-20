# A2 — Grading logic audit

**Audit item:** A2 — "the grading function… I think that there needs to be an audit on just the AEO logic itself" (Bob, Sep 16)
**Date:** 2026-09-20
**Author:** RJ (Razel De Jesus), with Claude Code
**Method:** code read at `main@f9dd267` plus read-only analysis of all 290 stored results, including 600 stored Claude prompt/response pairs from the 60 most recent audits. **No live audits were run.**
**Deliverable:** findings only. Nothing here has been fixed.

The question this report answers is the one a client will ask: *why did I get this number, and would I get it again tomorrow?* The short answer is that for most sites the number is dominated by a 40%-weighted signal produced by a measurement instrument that is rebuilt on every run and that counts an AI saying "I'm not familiar with your site" as a citation.

---

## 1. Where the number comes from

```
overall = citation_rate × 0.40                     ← 40%, the AI probe
        + answerability × 0.12                     ← robots + sitemap + canonical + OG
        + brevity      × 0.12                      ← actually the SCHEMA score
        + trust        × 0.12                      ← external links + OG + canonical
        + structure    × 0.12                      ← word count + link counts
        + freshness    × 0.12                      ← always 0 (A1-F1)

citation_rate = (prompts whose answer contained a matching substring) / (prompts asked)
```

Everything except the citation rate is a **hand-written checklist of boolean bonuses** — no model,
no statistics, no external data ([scoring.ts:39-91](../../src/lib/scoring.ts#L39)). The citation
rate is the only part that looks at the outside world, and it carries more weight than everything
else combined.

### The dimension names do not describe what they measure

| Column the client sees | What is actually stored there |
|---|---|
| `answerability_score` | robots.txt + sitemap + canonical + Open Graph checklist |
| `brevity_score` | the **schema markup** score |
| `structure_score` | word count and link counts |
| `trust_score` | external link count + OG + canonical |
| `freshness_score` | the constant 0 |

The mapping is done in one place, [scoring.ts:186-195](../../src/lib/scoring.ts#L186). Nothing about
brevity is measured anywhere in the codebase.

### Four weight sets and two grade ladders ship in the same build

| Where | Weights | Used by |
|---|---|---|
| [crawl/route.ts:511-516](../../src/app/api/audit/crawl/route.ts#L511) | AI .40, five dims .12 each | fallback pipeline — **live** |
| [functions.ts:442-447](../../src/lib/inngest/functions.ts#L442) | identical copy | primary pipeline — **live** |
| [scoring.ts:19-33](../../src/lib/scoring.ts#L19) | .25 / .25 / .20 / .15 / .15 | computed on every audit, then **discarded** |
| [types.ts:52-58](../../src/lib/types.ts#L52) | .40 / .20 / .20 / .10 / .10 | legacy endpoint only |

| Grade ladder | A+ | A | B | C | D |
|---|---|---|---|---|---|
| [scoring.ts:7-17](../../src/lib/scoring.ts#L7) — live | ≥90 | ≥80 | ≥70 | ≥60 | ≥50 |
| [types.ts:68-74](../../src/lib/types.ts#L68) — legacy | — | ≥90 | ≥80 | ≥70 | ≥60 |

A score of 75 is a **B** on one ladder and a **C** on the other. Both are in the shipped bundle.

---

## 2. Findings, ranked

### G1 — CRITICAL. "Cited" means a substring appeared. It counts denials as citations.

Every engine decides citation the same way ([ai-probe.ts:95](../../src/lib/auditor/ai-probe.ts#L95),
[:139](../../src/lib/auditor/ai-probe.ts#L139), [:186](../../src/lib/auditor/ai-probe.ts#L186),
[:353](../../src/lib/auditor/ai-probe.ts#L353)):

```ts
const cited = variants.some(v => lower.includes(v));
```

`variants` is the hostname, **the bare first label of the domain**, the company name, and the company
name with spaces removed ([ai-probe.ts:40-49](../../src/lib/auditor/ai-probe.ts#L40)). No word
boundaries, no sentiment, no check that the mention is a recommendation.

**Measured, in the 600 stored Claude responses from the 60 most recent audits — 103 counted as citations:**

| How the "citation" was matched | Count |
|---|---|
| Full hostname appeared (defensible) | **11** |
| Only the bare domain label appeared | 55 — of which **10** had the label buried inside a longer word |
| Only the company-name variant appeared | 37 |
| Of all 103, the answer explicitly says it does **not** know the brand | **9** |

Two examples from production data:

> **ppllgg.com — counted 10/10 cited on Claude.** The first answer begins: *"I'm not familiar with
> **ppllgg.com** as an established…"* It is counted as a citation because the phrase contains the
> domain — which it contains because the prompt named it.

> **youtu.be — counted 10/10 cited on Claude.** The bare label is `youtu`, so every answer mentioning
> *YouTube* scored as a citation of the audited site.

**Why it matters:** this is 40% of every grade, and it is the number the report headlines as "2 of 40
AI prompts cited your brand". A client who reads the stored responses will find their "citations"
include an AI saying it has never heard of them.

### G2 — CRITICAL. The questions change on every run, so no two audits measure the same thing

The prompts are generated by an LLM from the crawled page titles and headings on every single run
([functions.ts:257-300](../../src/lib/inngest/functions.ts#L257)), with no temperature control, no
seed, and no storage of a canonical prompt set per domain. The probe calls that follow are also
uncontrolled — default sampling, no `temperature: 0`.

So a re-audit asks *different questions* of *non-deterministic models* and reports the delta as a
change in the client's AI visibility. This is the mechanism behind the variance measured in A1:
**31 of 58 same-day re-audits changed score, 8 changed the letter grade, one moved 75 → 43.**

Anything built on top — trend lines, "your visibility improved", the client dashboard in the
ideation section of the handoff — inherits this. A time series over a re-randomised instrument
measures the instrument, not the client.

### G3 — CRITICAL. Two of the four "AI engines" never search the web

| Engine as advertised | What the code does | Searches the live web? |
|---|---|---|
| "ChatGPT (GPT-4o)" | plain `chat.completions.create`, no tools ([ai-probe.ts:132-137](../../src/lib/auditor/ai-probe.ts#L132)) | **No** |
| "Claude" | plain `messages.create`, no tools ([ai-probe.ts:88-92](../../src/lib/auditor/ai-probe.ts#L88)) | **No** |
| "Perplexity" | `sonar` model | Yes |
| "Google AI Overviews" | SerpAPI result parsing | Yes (see G4) |

Half the score's inputs therefore measure **what the model remembers from training**, not whether a
site is cited in AI search. The homepage asks "If your customers ask ChatGPT for recommendations,
will they hear about you?" — a real customer's ChatGPT has browsing; this probe does not. For any
site younger than the model's training cutoff, the answer is structurally "no citation", regardless
of how visible the site actually is in ChatGPT today.

### G4 — CRITICAL. The Google engine counts a top-5 organic ranking as an AI citation

When no AI Overview, answer box or knowledge panel appears, the code falls back to scanning the
first five organic search results and marks the site cited if it appears
([ai-probe.ts:279-287](../../src/lib/auditor/ai-probe.ts#L279)):

```ts
if (!aiText) {
  aiText = 'No AI Overview appeared for this query';
  if (data.organic_results) {
    for (const result of data.organic_results.slice(0, 5)) {
      if (result.link?.toLowerCase().includes(domainLower)) { cited = true; … }
```

That is classical SEO ranking, relabelled and folded into a score the product sells as AI
visibility — on the engine the site describes as "missing here means missing where it matters most".
A site with strong traditional SEO and zero AI presence scores as cited.

### G5 — HIGH. When the probe fails, the grade goes **up**

Both pipelines drop `ai_citation` entirely when no prompts came back and average the five remaining
dimensions instead ([crawl/route.ts:519-521](../../src/app/api/audit/crawl/route.ts#L519),
[functions.ts:450-452](../../src/lib/inngest/functions.ts#L450)). Since a site with no citations
would score 0 on that dimension, removing it deletes a zero and lifts the average.

**Measured:** 12 stored audits ran with zero AI prompts. Re-scoring them with `ai_citation = 0`:

| Currently shows | Would be | Count |
|---|---|---|
| B | F | 2 |
| C | F | 5 |
| D | F | 1 |
| unchanged | | 4 |

**Eight of twelve carry a grade the scoring rules would not give them**, and two of those are B —
shown to the client as "Good AEO foundation. Several opportunities exist."

*Discrepancy to resolve before quoting either figure to Bob:* the parked branch `fix/ai-probe-caveat`
states 23 affected audits, 14 F-flips and 3 Bs. This report measures 12 / 8 / 2 by reconstructing
each stored row's arithmetic from its own dimension scores and probe totals. The two counts use
different definitions of "the probe did not run" and the difference has not been reconciled.

### G6 — HIGH. When prompt generation fails, the fallback prompts name the client's domain

The catch branch builds prompts like *"What are the leading alternatives to `<domain>`?"*
([functions.ts:301-318](../../src/lib/inngest/functions.ts#L301)). The model then repeats the domain
in its answer — and the substring check counts that as a citation.

**Measured:** 4 audits ran on the fallback prompt set. Their mean citation rate is **51.9%**, against
**14.3%** for audits with generated prompts — a 3.6× inflation caused entirely by the prompt text.
Three of the four scored 10/10 on Claude, including the ppllgg.com case in G1.

### G7 — HIGH. Two hardcoded inputs distort every grade, and generate false advice

Detailed in A1 (F1, F2) and not repeated here, except for the grading consequence:

- `freshness` is **0 in 290 of 290 audits** — 12% of every grade is a constant.
- `answerability` cannot exceed **70** because `sitemapListed` is hardcoded false, and 70 is exactly
  the maximum observed across all 290 audits.

The same two constants drive the client-facing advice
([insights.ts:17-21](../../src/lib/audit/insights.ts#L17),
[:37-41](../../src/lib/audit/insights.ts#L37)). `sitemapListed` is always false, so **every report
recommends "No sitemap entry detected. Submit an XML sitemap"** — including to sites whose sitemap
the crawler just finished reading. Only three insights are shown, and this one is second in
priority, so it occupies a slot in effectively every report.

### G8 — HIGH. The scale cannot reach its own top, and defaults to F

Combine the two caps with the weights and the arithmetic ceiling is fixed:

| Scenario (everything else perfect) | Maximum overall |
|---|---|
| 100% citation rate across all engines | **84** → A |
| No citations at all | **44** → F |

**A+ is unreachable. A technically flawless site with no AI citations cannot score above 44.**

Observed across 290 audits: highest score **76**, median **42**, and the grade distribution is
**F 233, D 29, C 19, B 9, A 0, A+ 0** — 80% of everything ever audited is an F. That is not a
finding about the websites; it is a property of the scale.

### G9 — MEDIUM. The thresholds are round numbers with no stated basis

Every constant in the checklist is an unexplained round number: robots 40 / sitemap 30 / canonical
20 / OG 10 ([scoring.ts:42-45](../../src/lib/scoring.ts#L42)); 300 and 600 words
([scoring.ts:63-64](../../src/lib/scoring.ts#L63)); "≥3 internal links" and "≥1 external link"
([scoring.ts:65-66](../../src/lib/scoring.ts#L65)); schema scoring as `50 + 10 × (unique @type − 1)`
([scoring.ts:53](../../src/lib/scoring.ts#L53)), which rewards the *count of distinct `@type`
strings* rather than whether the markup is correct or relevant; and the per-engine label thresholds
`cited ≥ 4 → "cited"`, `≥ 1 → "partial"` ([ai-probe.ts:114](../../src/lib/auditor/ai-probe.ts#L114)).

None of these are wrong on their face. The problem is that none is defended anywhere, so none can be
defended to a client — and two of them (freshness buckets, sitemap) score inputs that are never
collected.

### G10 — MEDIUM. The methodology is documented nowhere

`README.md` does not mention score, grade or weight. There is no methodology page, no scoring
document, and no in-product explanation of how the number is produced. The only docs in the repo are
`DESIGN_SYSTEM.md` and `docs/hubspot-setup.md`. Answering "why did I get this number?" today requires
reading four source files and knowing which of the two pipelines ran.

For a tool whose output is used in sales conversations, and whose client-facing weights differ from
the ones in its own shared scoring module, this is the gap that turns a bug into a credibility
problem.

### G11 — LOW. Latent: an empty company name would make Google report 100% citation

`probeGoogleAI` tests `lower.includes(nameLower)` without the guard the other engines have
([ai-probe.ts:292](../../src/lib/auditor/ai-probe.ts#L292)). `"anything".includes("")` is `true`, so
an empty company name would mark every prompt cited. **Not currently reachable** — the caller
defaults the name to the domain label ([functions.ts:302](../../src/lib/inngest/functions.ts#L302)) —
and the 8 failed-crawl audits in the data all show Google 0/10, confirming it has not fired. Worth
fixing when that code is next touched, not before.

---

## 3. What is sound

- The **crawl-derived checks are honest about their inputs**: every dimension is computed from data
  actually collected, and a missing input scores zero rather than being invented.
- `clamp()` is applied consistently, and `getGrade` throws on out-of-range input rather than
  silently producing a wrong letter ([scoring.ts:8-10](../../src/lib/scoring.ts#L8)).
- The probe **stores its evidence**: prompts, responses and per-prompt cited flags are all persisted
  in `raw_findings`. Every measurement in this report was possible only because of that, and it is
  the single best thing about the design. A tool that saves its working can be audited; most cannot.
- Scoring is pure and separable — `runScorers` has no I/O, which is why the parked branch could add
  tests for it without touching the pipeline.
- The four engines are queried in parallel and a failure in one does not abort the others
  ([functions.ts:398-406](../../src/lib/inngest/functions.ts#L398)).

## 4. What could not be verified

| Item | Why |
|---|---|
| Whether a controlled re-run reproduces a score when prompts are held fixed | Requires live runs with a pinned prompt set; none were made |
| True false-positive rate of the citation check | The 9% denial figure is a lower bound from one regex over one sample; a proper estimate needs human labelling of a sample of cited responses |
| How Perplexity and Google engines compare to what a real user sees | Needs side-by-side manual checks |
| Whether the 23/14/3 figures on the parked branch or the 12/8/2 here are the right ones | Both methods are defensible; they were not reconciled (G5) |
| Whether any client has been shown a grade that later changed | Would need the HubSpot record of what was sent, which is A3 |

## 5. Suggested triage order — for RJ, not to be acted on yet

1. **G1** — replace substring matching with, at minimum, word-boundary matching on the full hostname
   plus an explicit-mention check. This one change moves the headline number more than anything else
   on the list, and it is the one a client can most easily catch.
2. **G5** — stop dropping `ai_citation`; score it as 0 and say the probe failed. The fix is already
   written and tested on `fix/ai-probe-caveat`; it needs the count in G5 reconciled, then review.
3. **G7** — the two hardcoded constants, which also clean up the false advice in the insights list.
4. **G2 / G3 / G4** — these are **product decisions before they are code changes.** What is the tool
   claiming to measure: presence in model memory, or citation in live AI search? The answer decides
   whether prompts get pinned per domain, whether the non-searching engines get browsing enabled, and
   whether the organic-results fallback is legitimate or has to go.
5. **G8** — once the caps are fixed, re-check the distribution. If 80% of sites still score F, the
   scale needs recalibrating before it is used in a client report.
6. **G10** — write the methodology down. Whatever the numbers end up being, they have to be
   explainable in one page.

**Nothing above should be fixed in isolation.** G1, G2 and G5 all change the headline score, so
fixing them one at a time means three separate "your grade changed" conversations with anyone who
has already seen a report. Re-scoring the 290 stored audits after the fixes would show how far the
existing reports have drifted — that is a worthwhile piece of work in itself, and it is cheap because
the raw evidence is all still in the database.

## 6. Reproducing the measurements

All read-only, via PostgREST against the production project:

- Formula attribution: recomputed each row's weighted and averaged overall from its own stored
  dimension scores and probe totals, matched against `overall_score` with ±1 rounding tolerance.
- Citation forensics: `raw_findings->aiProbe->claude->results` for the 60 most recent audits
  (600 prompt/response pairs, ~437 KB), classified by whether the hostname, the bare label, or the
  company-name variant produced the match, with the bare-label matches re-tested for word boundaries.
- Fallback-prompt detection: an audit is counted as having used the fallback set when ≥80% of its
  stored prompts contain its own hostname.
- Ceiling arithmetic: `0.40 × ai + 0.12 × (70 + 100 + 100 + 100 + 0)`, using the observed maxima for
  each dimension.
