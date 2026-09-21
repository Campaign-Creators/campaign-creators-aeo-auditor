import type {
  AiProbeStatus,
  CrawlPage,
  CrawlRobotsData,
  RawFindings,
} from '@/src/types/audit';

export function getGrade(score: number): string {
  if (score < 0 || score > 100) {
    throw new Error('Score out of bounds: must be 0–100');
  }
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

export function computeOverallScore(scores: {
  ai_crawler: number;
  schema: number;
  content_structure: number;
  authority: number;
  freshness: number;
}): number {
  const result =
    scores.ai_crawler * 0.25 +
    scores.schema * 0.25 +
    scores.content_structure * 0.2 +
    scores.authority * 0.15 +
    scores.freshness * 0.15;
  return Math.round(result * 100) / 100;
}

function clamp(score: number): number {
  return Math.max(0, Math.min(100, score));
}

export function scoreAiCrawler(findings: RawFindings | null | undefined): number {
  if (!findings) return 0;
  let score = 0;
  if (findings.robotsTxtAllowsAI) score += 40;
  if (findings.sitemapListed) score += 30;
  if (findings.canonicalUrl !== null) score += 20;
  if (findings.openGraphPresent) score += 10;
  return clamp(score);
}

export function scoreSchema(findings: RawFindings | null | undefined): number {
  if (!findings) return 0;
  const uniqueTypes = Array.from(new Set(findings.structuredDataTypes));
  if (uniqueTypes.length > 0) {
    const score = 50 + (uniqueTypes.length - 1) * 10;
    return clamp(score);
  }
  if (findings.schemaMarkup.length > 0) return clamp(20);
  return 0;
}

export function scoreContentStructure(findings: RawFindings | null | undefined): number {
  if (!findings) return 0;
  let score = 0;
  if (findings.wordCount >= 300) score += 30;
  if (findings.wordCount >= 600) score += 20;
  if (findings.internalLinks.length >= 3) score += 25;
  if (findings.externalLinks.length >= 1) score += 25;
  return clamp(score);
}

export function scoreAuthority(findings: RawFindings | null | undefined): number {
  if (!findings) return 0;
  let score = 0;
  if (findings.externalLinks.length >= 5) score += 40;
  else if (findings.externalLinks.length >= 1) score += 20;
  if (findings.openGraphPresent) score += 30;
  if (findings.canonicalUrl !== null) score += 30;
  return clamp(score);
}

export function scoreFreshness(findings: RawFindings | null | undefined): number {
  if (!findings) return 0;
  if (findings.lastModified === null) return 0;
  const lastModMs = new Date(findings.lastModified).getTime();
  if (Number.isNaN(lastModMs)) return 0;
  const ageDays = (Date.now() - lastModMs) / (1000 * 60 * 60 * 24);
  if (ageDays <= 30) return clamp(100);
  if (ageDays <= 90) return clamp(70);
  if (ageDays <= 180) return clamp(50);
  if (ageDays <= 365) return clamp(30);
  return clamp(10);
}

export interface RunScorersInput {
  crawledPages: CrawlPage[];
  robotsData: CrawlRobotsData;
  domainUrl: string;
}

export interface RunScorersResult {
  answerability_score: number;
  answerability_grade: string;
  structure_score: number;
  structure_grade: string;
  trust_score: number;
  trust_grade: string;
  freshness_score: number;
  freshness_grade: string;
  brevity_score: number;
  brevity_grade: string;
  overall_score: number;
  overall_grade: string;
  raw_findings: RawFindings;
}

function deriveFindingsFromCrawl(input: RunScorersInput): RawFindings {
  const pages = input.crawledPages;
  const primary = pages.find((p) => p.fetchError === null) ?? pages[0] ?? null;

  const robotsTxtAllowsAI =
    !input.robotsData.gptBotDisallowed &&
    !input.robotsData.claudeBotDisallowed &&
    !input.robotsData.fullDisallowAll;

  if (!primary) {
    return {
      url: input.domainUrl,
      htmlSnapshot: '',
      schemaMarkup: [],
      internalLinks: [],
      externalLinks: [],
      wordCount: 0,
      lastModified: null,
      robotsTxtAllowsAI,
      sitemapListed: false,
      canonicalUrl: null,
      openGraphPresent: false,
      structuredDataTypes: [],
    };
  }

  const internal = new Set<string>();
  const external = new Set<string>();
  const types = new Set<string>();
  let words = 0;
  let openGraph = false;
  for (const page of pages) {
    page.internalLinks.forEach((l) => internal.add(l));
    page.externalLinks.forEach((l) => external.add(l));
    page.structuredDataTypes.forEach((t) => types.add(t));
    words += page.wordCount;
    if (Object.keys(page.openGraphTags).length > 0) openGraph = true;
  }

  return {
    url: primary.url,
    htmlSnapshot: primary.bodyText,
    schemaMarkup: Array.from(types),
    internalLinks: Array.from(internal),
    externalLinks: Array.from(external),
    wordCount: words,
    lastModified: null,
    robotsTxtAllowsAI,
    sitemapListed: false,
    canonicalUrl: primary.canonicalUrl,
    openGraphPresent: openGraph,
    structuredDataTypes: Array.from(types),
  };
}

export function runScorers(input: RunScorersInput): RunScorersResult {
  const findings = deriveFindingsFromCrawl(input);
  const ai_crawler = scoreAiCrawler(findings);
  const schema = scoreSchema(findings);
  const content_structure = scoreContentStructure(findings);
  const authority = scoreAuthority(findings);
  const freshness = scoreFreshness(findings);
  const overall = computeOverallScore({
    ai_crawler,
    schema,
    content_structure,
    authority,
    freshness,
  });

  return {
    answerability_score: ai_crawler,
    answerability_grade: getGrade(ai_crawler),
    structure_score: content_structure,
    structure_grade: getGrade(content_structure),
    trust_score: authority,
    trust_grade: getGrade(authority),
    freshness_score: freshness,
    freshness_grade: getGrade(freshness),
    brevity_score: schema,
    brevity_grade: getGrade(schema),
    overall_score: overall,
    overall_grade: getGrade(overall),
    raw_findings: findings,
  };
}

/* ---------------------------------------------------------------------------------------------
 * The overall score, and whether the AI-visibility half of it actually ran.
 *
 * WHY THIS IS HERE AND NOT AT THE CALL SITE
 *
 * This arithmetic was written twice — once in app/api/audit/crawl/route.ts and once in
 * lib/inngest/functions.ts — and the two copies had already drifted in how they read the probe
 * (one expects a single result object, the other sums four engines). Both carried the same
 * defect, so fixing one would have fixed half the audits.
 *
 * THE DEFECT. When the probe returned nothing, the old code silently dropped ai_citation and
 * averaged the remaining five dimensions equally. ai_citation is 40% of the score and a site
 * that nothing cites scores ZERO there, so dropping it does not neutralise the dimension — it
 * deletes a zero. A site whose other five average 70 scores 42 (F) when the probe runs and 70
 * (B) when it fails. Re-measured against the live database on 2026-09-20, using probeTotals()
 * below as the definition of "the probe ran": 12 of 290 stored reports took that path, 8 carry a
 * grade that would otherwise be F, and 2 of those are showing a B. (An earlier note said 23/14/3;
 * that count inferred the path from the stored score matching the 5-dimension average, which also
 * catches reports whose probe ran. The rows themselves have not changed since 2026-09-14.)
 *
 * WHAT CHANGED. The numbers are deliberately IDENTICAL to before. Re-scoring 290 historical
 * reports is not this function's decision to make. What is new is that the result says which
 * formula produced it, so the report can tell the reader that the AI check did not run instead
 * of presenting a confident grade built on a missing 40%.
 * ------------------------------------------------------------------------------------------- */

/** ai_citation's share of the overall score. The other five split the remainder evenly. */
export const AI_CITATION_WEIGHT = 0.4;
/** Each of answerability, brevity, trust, structure, freshness. 5 x 0.12 + 0.40 = 1.00. */
export const CONTENT_DIMENSION_WEIGHT = 0.12;

/** A probe reduced to the only two numbers scoring needs. */
export interface AiProbeTotals {
  citedCount: number;
  totalPrompts: number;
}

export interface OverallResult {
  overall_score: number;
  overall_grade: string;
  /** 'unavailable' means ai_citation is NOT in overall_score — say so on the report. */
  ai_probe_status: AiProbeStatus;
  /** null when the probe did not run. Zero is a real answer and means "cited nowhere". */
  ai_citation_score: number | null;
  ai_prompts_total: number;
  ai_cited_count: number;
}

/**
 * Reduce either probe shape to totals, or null when there is nothing to score.
 *
 * Two shapes exist because the two call sites grew apart: the crawl route probes Claude alone
 * and hands back one result object; the Inngest pipeline probes four engines and hands back a
 * map of them. Both are accepted here so neither call site has to know about the other.
 *
 * A probe that ran and returned zero prompts is treated as NOT having run. An empty denominator
 * cannot express "cited nowhere" — it can only express "we did not ask".
 */
export function probeTotals(probe: unknown): AiProbeTotals | null {
  if (!probe || typeof probe !== 'object') return null;
  const p = probe as Record<string, unknown>;

  const readOne = (v: unknown): AiProbeTotals | null => {
    if (!v || typeof v !== 'object') return null;
    const e = v as Record<string, unknown>;
    const total = typeof e.totalPrompts === 'number' ? e.totalPrompts : 0;
    const cited = typeof e.citedCount === 'number' ? e.citedCount : 0;
    if (total <= 0) return null;
    return { citedCount: cited, totalPrompts: total };
  };

  const single = readOne(p);
  if (single) return single;

  let citedCount = 0;
  let totalPrompts = 0;
  for (const key of ['claude', 'openai', 'perplexity', 'google']) {
    const one = readOne(p[key]);
    if (one) {
      citedCount += one.citedCount;
      totalPrompts += one.totalPrompts;
    }
  }
  return totalPrompts > 0 ? { citedCount, totalPrompts } : null;
}

export function computeOverall(
  scored: Pick<
    RunScorersResult,
    | 'answerability_score'
    | 'brevity_score'
    | 'trust_score'
    | 'structure_score'
    | 'freshness_score'
  >,
  probe: AiProbeTotals | null,
): OverallResult {
  const five =
    scored.answerability_score +
    scored.brevity_score +
    scored.trust_score +
    scored.structure_score +
    scored.freshness_score;

  if (!probe) {
    // No AI data. Score the five dimensions we DO have, on their own scale, and flag it.
    const overall = Math.round(five / 5);
    return {
      overall_score: overall,
      overall_grade: getGrade(overall),
      ai_probe_status: 'unavailable',
      ai_citation_score: null,
      ai_prompts_total: 0,
      ai_cited_count: 0,
    };
  }

  const aiCitationScore = (probe.citedCount / probe.totalPrompts) * 100;
  const overall = Math.round(
    aiCitationScore * AI_CITATION_WEIGHT + five * CONTENT_DIMENSION_WEIGHT,
  );
  return {
    overall_score: overall,
    overall_grade: getGrade(overall),
    ai_probe_status: 'ok',
    ai_citation_score: aiCitationScore,
    ai_prompts_total: probe.totalPrompts,
    ai_cited_count: probe.citedCount,
  };
}
