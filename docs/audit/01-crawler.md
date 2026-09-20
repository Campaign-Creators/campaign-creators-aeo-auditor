# A1 — Crawler audit

**Audit item:** A1 — "make sure that the crawler is actually doing what it's supposed to be doing technically" (Bob, Sep 16)
**Date:** 2026-09-20
**Author:** RJ (Razel De Jesus), with Claude Code
**Method:** code read of the live pipeline at `main@f9dd267`, plus read-only analysis of all 304 audit requests and 290 stored results in the production database. **No live audits were run** — nothing in this document cost API credits.
**Deliverable:** findings only. Nothing here has been fixed.

---

## 1. The standard being applied

A1 came with no acceptance criteria, so the promise the tool makes to the visitor is the standard used
below. Taken from aeo.campaigncreators.com on 2026-09-20:

| The site says | Measured reality |
|---|---|
| "Results in ~90 seconds" | Median **182s**, p90 **921s** (15 minutes). n=290 |
| "Site crawl — scan pages, content, schema, and metadata" | **46 of 290 audits scanned exactly one page.** 9 scanned ≥200 |
| "We test your visibility across 4 AI engines" | 273 of 290 got 4 engines; **17 got none**; 25 ran a reduced prompt set |
| Sample report: "TOP WEAKNESS: **Freshness**" | Freshness is **hardcoded to zero for every site that has ever been audited** (F1) |
| "Calculate citations, mentions, accuracy" | Citation rate is real, but its denominator varies between audits (F9) |

## 2. How it actually works

There are **two complete crawler implementations**, plus a third that is shipped but only reachable
from a legacy endpoint.

```
POST /api/audit/start          ← the UI calls this (AuditForm.tsx:63)
  ├── rate limit 5/hour/IP     (rateLimit.ts:16)
  ├── SSRF guard on the submitted host  (start/route.ts:44-88)
  ├── INSERT audit_requests (status=pending)
  ├── inngest.send('audit/requested')  ──► PRIMARY:  lib/inngest/functions.ts
  │                                        MAX_PAGES = 200, probes 4 engines
  └── on send failure → POST /api/audit/crawl  ──► FALLBACK: app/api/audit/crawl/route.ts
                                             MAX_PAGES = 50, probes Claude only

POST /api/audit               ← LEGACY, still deployed, nothing calls it
  └── lib/auditor/index.ts + lib/auditor/checks/*   in-memory only, no rate limit, no SSRF guard
```

The primary and fallback files are near-verbatim copies of each other — same `parseRobots`, same
sitemap discovery, same crawl loop, same inlined scoring arithmetic — differing in the two constants
that matter most. Evidence that both have served real traffic is in the stored data: 273 results
carry the 4-engine probe shape, **5 carry the fallback's Claude-only shape**, 12 carry none.

Per audit the pipeline makes roughly **41 paid model calls** (10 prompts × 4 engines, plus one
Claude call to generate the prompts) across Anthropic, OpenAI, Perplexity and SerpAPI.

## 3. Findings, ranked

### F1 — CRITICAL. A twelfth of every grade is hardcoded to zero

`deriveFindingsFromCrawl` sets `lastModified: null` unconditionally, in both of its return branches
([scoring.ts:132](../../src/lib/scoring.ts#L132), [scoring.ts:161](../../src/lib/scoring.ts#L161)).
`scoreFreshness` returns 0 the moment `lastModified` is null ([scoring.ts:82](../../src/lib/scoring.ts#L82)).
The scorer itself is fully implemented — 30/90/180/365-day age buckets — and never receives an input.

The crawler never collects a date. `CrawlPage` has no date field, and the fetch discards the
response headers, so the `Last-Modified` header that arrived with every page is thrown away.

**Evidence:** `freshness_score = 0` in **290 of 290** stored audits. Not "usually zero" — always.

**Why it matters:** freshness carries 12% of the overall score when the AI probe runs and 20% when
it does not. Every site ever audited has been marked down for it, and the homepage's own sample
report advertises "TOP WEAKNESS: Freshness" — the tool is selling a diagnosis it cannot make.

### F2 — CRITICAL. The "Answerability" dimension is capped at 70 and measures something else

Two defects in the same place:

1. `scoreAiCrawler` awards 30 of its 100 points for `sitemapListed` ([scoring.ts:43](../../src/lib/scoring.ts#L43)),
   and `sitemapListed` is hardcoded `false` ([scoring.ts:134](../../src/lib/scoring.ts#L134),
   [scoring.ts:163](../../src/lib/scoring.ts#L163)) — even though the crawler discovers and reads the
   sitemap a few lines earlier. Maximum attainable: 70.
2. The result is stored as `answerability_score` ([scoring.ts:186](../../src/lib/scoring.ts#L186)) but
   it is the crawler-friendliness score. `brevity_score` likewise holds the **schema** score.

**Evidence:** across 290 audits `answerability_score` takes exactly six values — 0, 30, 40, 50, 60, 70 —
and never exceeds 70, matching the arithmetic.

**Why it matters:** a client asking "why is my answerability 70 and not higher?" cannot be given a
true answer, because no site can score higher, and because the number is not about answerability.

### F3 — CRITICAL. The same site audited twice on the same day gets a different grade

Of 58 cases where one domain was re-audited within 24 hours, **31 produced a different overall score
and 8 changed the letter grade.** Largest swing: grinoralcare.com, 13.8 hours apart, **75 → 43**.

In nearly every case the four content dimensions are byte-identical between the two runs
(`70/100/100/0 → 70/100/100/0`), so the movement is coming from the AI citation probe, which carries
40% of the grade. Two runs of campaigncreators.com six minutes apart: 48 → 53 → 48.

**Why it matters:** this is the number a prospect is shown and a sales conversation is built on. Two
screenshots taken the same afternoon can disagree by a letter grade, and the report gives the reader
no reason to expect that.

### F4 — HIGH. Two crawlers, two answers, one report

Primary crawls up to 200 pages and probes 4 engines
([functions.ts:8](../../src/lib/inngest/functions.ts#L8)); the fallback crawls up to 50 and probes
Claude alone ([crawl/route.ts:18](../../src/app/api/audit/crawl/route.ts#L18)). Which one runs depends
on whether `inngest.send` throws ([start/route.ts:180-209](../../src/app/api/audit/start/route.ts#L180)).
The outputs are written to the same columns and rendered by the same report.

**Evidence:** 5 stored results carry the single-engine shape — the fallback has run in production.
A citation rate computed from one engine is not comparable to one computed from four, and nothing
distinguishes them afterwards.

### F5 — HIGH. Failure is invisible: nothing has ever been marked failed

| Status | Count |
|---|---|
| `complete` | 290 |
| `processing` | 8 |
| `pending` | 6 |
| `failed` | **0** |

The 14 stuck rows are ~115 days old. The `failed` write exists
([crawl/route.ts:559](../../src/app/api/audit/crawl/route.ts#L559)) but only fires if the handler
catches an exception — a platform timeout kills the process instead, so nothing is written and the
row stays `processing` forever. The status route treats `pending`/`processing` as "still working"
([status/route.ts:87](../../src/app/api/audit/%5BauditId%5D/status/route.ts#L87)), so the visitor's
progress screen spins indefinitely.

Contributing cause: the Inngest serving route sets **no `maxDuration`**
([api/inngest/route.ts](../../src/app/api/inngest/route.ts)), so the 200-page crawl step runs under
the platform default, while the fallback route explicitly asks for 60s
([crawl/route.ts:9](../../src/app/api/audit/crawl/route.ts#L9)). Neither is enough for the
worst case the constants allow: 200 pages × (10s timeout + 500ms delay) ≈ 35 minutes.

### F6 — HIGH. The crawler does not identify itself and does not obey robots.txt

- **User-Agent is literally `node`.** Measured: the live fetch helper
  ([crawl/route.ts:120-134](../../src/app/api/audit/crawl/route.ts#L120),
  [functions.ts:111-118](../../src/lib/inngest/functions.ts#L111)) sets no headers, so Node's default
  goes out. A polite, self-identifying agent string exists in the codebase
  ([fetch.ts:2-3](../../src/lib/auditor/fetch.ts#L2)) — in the file the live path does not use.
- **robots.txt is parsed for scoring and then ignored for crawling.** `fullDisallowAll` is computed
  and never consulted before fetching. `Crawl-delay` is not read; the delay is a fixed 500ms.

**Why it matters:** two ways. Sites behind bot protection return 403 to `node`, and that gets
recorded as the site's content being thin — the tool blames the customer for blocking it. And a
lead-gen tool crawling sites that have disallowed crawling is a defensible-conduct question for a
marketing agency, not just a technical one.

### F7 — HIGH (security). The legacy endpoint is live, unthrottled, and spends money

`POST /api/audit` is deployed (GET returns 405, so the route exists) and nothing in the UI calls it.
It runs the other implementation: no `checkRateLimit`, no `isPrivateOrIP` guard, results kept in an
in-memory `Map` ([store.ts](../../src/lib/auditor/store.ts)) that never reaches the database — and it
triggers the AI citation check, which calls a paid model.

Anyone who finds it can run unlimited audits that cost real money and leave **no row in
`audit_requests`** to show it happened. Its URL validator accepts IPv4 literals: `normalizeDomain`
requires only a dot and `[a-z0-9.-]` ([normalize.ts:22-23](../../src/lib/auditor/normalize.ts#L22)),
so `127.0.0.1` and `169.254.169.254` pass.

### F8 — HIGH (security). The SSRF guard is bypassed by the target's own sitemap

`/api/audit/start` validates the hostname the visitor submits. It does not validate the URLs the
crawler goes on to fetch: sitemap entries are pushed straight into the crawl queue
([crawl/route.ts:454](../../src/app/api/audit/crawl/route.ts#L454),
[functions.ts:377](../../src/lib/inngest/functions.ts#L377)) and fetched without re-checking.
`parseSitemapXml` returns whatever is inside `<loc>`, including a different host or a private
address. A site whose sitemap lists `http://169.254.169.254/...` gets the crawler to fetch it.

Discovered internal links are constrained to the origin host, so the sitemap is the exposed path.
Unverified against the live system — no attempt was made to exploit it.

### F9 — MEDIUM. The AI engine coverage degrades silently, and changes the denominator

| Probe outcome | Audits |
|---|---|
| 40 prompts (4 engines) | 248 |
| 24 prompts | 23 |
| 18 prompts | 2 |
| 0 prompts — no probe at all | 17 |

The citation score is `cited / totalPrompts × 100`, so an audit with 24 prompts is scored on a
different denominator than one with 40, and the report presents both as the same metric. The 17 with
no probe at all are the population behind the known grading defect (fix parked on
`fix/ai-probe-caveat`, see the B1 report §7).

### F10 — MEDIUM. Crawl depth is arbitrary, and the content scores ride on it

| Pages crawled | Audits |
|---|---|
| 1 | 46 |
| 2–4 | 20 |
| 5–9 | 17 |
| 10–24 | 76 |
| 25–49 | 73 |
| 50–99 | 32 |
| 100–199 | 17 |
| ≥200 | 9 |

Word count, structured-data types and link graphs are aggregated across whatever was reached
([scoring.ts:141-152](../../src/lib/scoring.ts#L141)), so a one-page audit and a 200-page audit are
scored on the same scale from different amounts of evidence. Depth depends on whether a sitemap was
found, how fast the site is, and where the platform timeout landed — not on the site's size.

### F11 — MEDIUM. Fetch failures and non-HTML responses are handled three different ways

- Network failure or timeout → a synthetic page with `statusCode: 0` and empty content, **counted as
  a crawled page** ([crawl/route.ts:136-159](../../src/app/api/audit/crawl/route.ts#L136)).
  8 stored audits have a first-page fetch error and were graded anyway.
- Non-HTML content type → `null`, silently dropped, not counted
  ([crawl/route.ts:188-191](../../src/app/api/audit/crawl/route.ts#L188)).
- HTTP status is never checked: `res.ok` is not consulted, so a 404 page that returns HTML is parsed
  and scored as if it were the site.

There is no guard for "zero usable pages": scoring proceeds on an empty crawl and the request is
still marked `complete`.

### F12 — LOW. Smaller things worth writing down

- **The submitted URL is silently rewritten.** `normalizeUrl` keeps only the hostname and forces
  https ([start/route.ts:90-93](../../src/app/api/audit/start/route.ts#L90)); `http://example.com/pricing`
  is audited as `https://example.com`. The report does not say so.
- **Deduplication is raw string equality** ([crawl/route.ts:448](../../src/app/api/audit/crawl/route.ts#L448)),
  so `/page`, `/page/` and `?utm=…` variants are crawled as separate pages and inflate depth.
- **No retries** on transient failures, and **no response size cap** — a large page is read fully
  into memory.
- **Dead code that reads like the real thing.** `src/lib/auditor/checks/*` is reachable only from the
  legacy endpoint. Its robots parser ignores `User-agent: *` entirely
  ([checks/crawlability.ts:67-81](../../src/lib/auditor/checks/crawlability.ts#L67)), so a site
  blocking every bot with a wildcard is told "GPTBot is technically allowed by default", and its
  maximum score is 90. Anyone auditing this repo opens that file first — it is the one with the
  legible check names — and draws conclusions about code no customer has ever hit.

## 4. What the crawler does correctly

Stated plainly, because the list above is one-sided and the tool is not fake:

- It performs **real HTTP fetches** and parses real markup with cheerio. Nothing is fabricated, and
  no scores are synthesised when data is missing — they are computed from whatever was actually found.
- Timeouts are bounded (8s robots, 8s sitemap, 10s per page) and there is a 500ms politeness delay
  between pages.
- Sitemap discovery follows the `Sitemap:` directive in robots.txt before falling back to
  `/sitemap.xml` — the correct order.
- The submitted hostname is checked against loopback, RFC1918, IPv6, `.local`/`.internal` and bare
  IPv4 literals ([start/route.ts:44-88](../../src/app/api/audit/start/route.ts#L44)). The guard is
  well written; F8 is about what happens after it.
- Rate limiting is real: 5 audits per IP per hour, enforced in the database.
- Results are upserted on `audit_request_id`, so a re-run replaces rather than duplicates.

## 5. What could not be verified

| Item | Why | How to close it |
|---|---|---|
| Behaviour on JS-rendered (SPA) sites | No live runs were made. The code has no JS rendering, so an SPA's content is invisible to it — but the *magnitude* of the effect is unmeasured | One paid run against a known SPA |
| Whether the 14 stuck audits failed at `inngest.send` or mid-crawl | Requires the Inngest dashboard; not accessible from here | Inngest run history for those auditIds |
| Per-engine API error rates | Only stored outcomes are visible; a failed engine leaves no record beyond its absence | Vercel runtime logs, or add error capture |
| Whether Vercel retains logs long enough to diagnose a failed crawl | No access to the log retention setting | Vercel dashboard |
| F8 in practice | Not exploited, deliberately | A controlled test with a sitemap you host |

**On logging generally** — A1 asked whether logs exist. They do, but only as `console.error` to the
platform ([rateLimit.ts:25](../../src/lib/rateLimit.ts#L25),
[crawl/route.ts:486](../../src/app/api/audit/crawl/route.ts#L486) and similar). Nothing about a
crawl's outcome is persisted anywhere queryable: not which pages failed, not which engines errored,
not why a run stopped. Every number in this report had to be reconstructed from `raw_findings`.
That is itself a finding — the system cannot explain its own results after the fact.

## 6. Suggested triage order — for RJ, not to be acted on yet

Ranked by client-facing risk per unit of work, not by severity alone:

1. **F1 and F2** — two hardcoded values (`lastModified`, `sitemapListed`) distort every grade the
   tool has ever produced. F1 also needs the crawler to keep the `Last-Modified` header it already
   receives. Smallest change, largest correction.
2. **F7** — delete or authenticate the legacy endpoint. It is an unmetered spend channel.
3. **F5** — a timeout that writes `failed`, and a UI that stops spinning. Users currently wait forever.
4. **F3** — decide what the product promises about reproducibility before changing the probe.
   This is a product decision, not only an engineering one.
5. **F4** — pick one pipeline, or record which one produced each result.
6. **F6, F8** — a User-Agent, robots obedience, and re-validating sitemap URLs. Each is small.

None of this has been started. The one adjacent change that already exists is the parked
`fix/ai-probe-caveat` branch, which addresses the reporting half of F9 and nothing else here.

## 7. Reproducing the measurements

Every number above comes from the production database, read-only, via PostgREST. The three queries:

- Status counts and durations: `audit_requests?select=id,url,status,created_at,updated_at`
- Score reproducibility: `audit_overview?select=audit_id,url,audit_date,overall_score,overall_grade,…`
  grouped by normalised host, pairs taken within 24h
- Crawl depth and probe coverage, without downloading the multi-megabyte `raw_findings` payloads:
  index probes such as `p50:raw_findings->pages->49->>url` and
  `oai:raw_findings->aiProbe->openai->>totalPrompts`. A non-null probe at index *n* proves at least
  *n+1* pages.
