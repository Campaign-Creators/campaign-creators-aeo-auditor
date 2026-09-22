# Drift study — how far the stored grades move once the hardcoded inputs are fixed

**Purpose:** quantify the effect of `fix/hardcoded-scoring-inputs` (PR #135) on real sites before it merges.
**Date:** 2026-09-22
**Author:** RJ (Razel De Jesus), with Claude Code
**Cost:** none. The crawl is plain HTTP; every paid call in this product is in the AI probe, and the probe was not run. 180 domains, 97 seconds.

---

## 1. What was measured, and how it was isolated

Every domain that has ever been audited — 180 distinct hosts, taken from the newest audit of each —
was re-crawled once (homepage + robots.txt + sitemap) with a self-identifying user agent. Each crawl
was then scored **twice against the same fetched page**:

| | Rule |
|---|---|
| **before** | what `main` does today — `lastModified` forced null, `sitemapListed` forced false |
| **after** | the PR — date read from the response and the page, sitemap checked against the audited host |

Everything else was **held at its stored value**: the AI citation rate from the original audit, and
the three dimensions the fix does not touch (`brevity`, `trust`, `structure`). That is deliberate.
Those three depend on how many pages were crawled, and this study crawls one page per site, so
re-measuring them would mix the fix's effect with a change in crawl depth. Holding them constant
means the numbers below are attributable to the fix and to nothing else.

Overall is recomputed with the shipped weights: `0.40 × citation rate + 0.12 × each dimension`.

## 2. Results

**153 of 180 domains returned crawlable HTML.** (The other 27 are a limitation of this run, not a
finding — see §4.)

| | |
|---|---|
| Publishes a usable date | **81 of 153** |
| Sitemap lists the audited host | **92 of 153** |
| Both signals present | 61 |
| Neither | 41 |

### Score movement

| | |
|---|---|
| Median change | **+6 points** |
| p75 / max | **+16 / +16** |
| Moved up | **112 of 153** |
| Unchanged | 41 — every one of them a site with no date *and* no sitemap |
| Moved down | **0** |

Nothing can move down: both corrections only add points that were previously unreachable.

### Grade changes — 63 of 153 (41%)

| Change | Count |
|---|---|
| F → D | 30 |
| F → C | 16 |
| D → C | 8 |
| C → B | 4 |
| D → B | 3 |
| B → A | 1 |
| C → A | 1 |

| Grade | Before | After |
|---|---|---|
| F | 127 | **81** |
| D | 17 | 36 |
| C | 7 | 26 |
| B | 2 | 8 |
| A | 0 | **2** |
| A+ | 0 | 0 |

**The tool has never issued an A.** Under the fix, two sites earn one: hubspot.com (73 B → 89 A, 73%
citation rate) and newbreedrevenue.com (64 C → 80 A, 50%). A+ remains unissued, which is now a fact
about the sites rather than an artefact of the scale.

### Twenty sites move two full grades or more

`adamsandreese.com`, `berkone.com`, `cageandmiles.com`, `capmo.com`, `comfortiqhome.com`,
`csiweb.com`, `datamagnet.co`, `deltadentalnc.com`, `gtia.org`, `hughesandcoleman.com`,
`iepdefenders.com`, `mediajunction.com`, `motionabx.com`, `omegafh.com`, `salesintel.io`,
`syncmatters.com` (all F → C), `retailnext.net`, `rivierapartners.com`, `seekout.com` (D → B),
and `newbreedrevenue.com` (C → A).

Campaign Creators' own site moves 40 F → 56 D.

## 3. What this means

Every stored report understates the site it describes, and for 41% of them the letter on the front
page is wrong in the client's favour to state it precisely — the site deserved better than it was
told. The two dimensions were not measuring anything, so their zero and their cap were pure
subtraction.

Three consequences worth deciding on separately:

1. **The fix should land.** Nothing about these numbers argues for delay; the current behaviour is
   strictly worse than the corrected behaviour on every site tested.
2. **Someone has to decide whether to tell anyone.** 63 domains were shown a grade that the
   corrected rules would not give them. Whether any of those were sent to a prospect or used in a
   sales conversation is a question for Bob and the HubSpot record — `aeo_overall_grade` was pushed
   to the CRM for every unlocked report (A3).
3. **Re-running the affected audits is cheap only for the crawl half.** A full re-audit re-runs the
   probe, which is ~41 paid model calls per site. Re-running all 63 is a real spend and would also
   change the citation rate, since the probe is not reproducible (A2-G2).

## 4. Limitations — read these before quoting the numbers

- **27 domains did not respond from this machine.** Spot-checking five of them (including espn.com)
  with both a bot user agent and a browser user agent produced identical failures — instant
  connection refusals or 20-second timeouts for both. That points at this network, not at the sites
  and not at bot blocking. Production crawls from Vercel and may reach them. They are excluded from
  every figure above; the real population is 180, not 153.
- **One page per site.** The production crawler reads up to 200. A deeper crawl can only find
  *more* dates, so the freshness figures here are a conservative floor.
- **This is not a prediction of a re-audit's score.** It isolates the fix. A real re-audit would also
  re-crawl at depth (moving `structure` and `trust`) and re-run the probe, which moves the 40%
  component by a median of several points on its own (A2-G3).
- **Stored citation rates were reused as-is**, including the 12 audits where the probe never ran.
  Those rows are wrong for a different reason, addressed on `fix/ai-probe-caveat`.

## 5. Reproducing it

The baseline is the newest audit per normalised host from `audit_requests` joined to
`audit_results`, read-only. The crawl used the same fetch shape as the production crawler with a
12-second timeout, 8 concurrent workers, and the self-identifying user agent from
`src/lib/auditor/fetch.ts` — which the live crawler still does not use (A1-F6). Scoring called the
real `runScorers` from this branch, twice per site, differing only in whether `sitemapUrls` was
passed and whether the page's `lastModified` was nulled first.
