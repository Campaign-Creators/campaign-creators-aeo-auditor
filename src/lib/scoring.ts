import type {
  CrawlPage,
  CrawlRobotsData,
  RawFindings,
} from '@/src/types/audit';
import { newerDate } from '@/lib/auditor/lastModified';

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
  /**
   * URLs discovered in the site's sitemap. Optional so older callers still compile;
   * omitting it means "no sitemap was read", which scores the same as not having one.
   */
  sitemapUrls?: string[];
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

function bareHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when the site's sitemap actually lists the audited domain.
 *
 * Deliberately stricter than "a sitemap file exists": a sitemap that 404s, is empty, or
 * points somewhere else is not a discoverability signal, and the recommendation the report
 * prints ("Submit an XML sitemap") should stop appearing only when there is one that works.
 */
export function sitemapListsAuditedDomain(
  sitemapUrls: string[],
  domainUrl: string,
): boolean {
  const audited = bareHost(domainUrl);
  if (!audited) return false;
  return sitemapUrls.some((entry) => bareHost(entry) === audited);
}

function deriveFindingsFromCrawl(input: RunScorersInput): RawFindings {
  const pages = input.crawledPages;
  const primary = pages.find((p) => p.fetchError === null) ?? pages[0] ?? null;

  const robotsTxtAllowsAI =
    !input.robotsData.gptBotDisallowed &&
    !input.robotsData.claudeBotDisallowed &&
    !input.robotsData.fullDisallowAll;

  // Both of the following were hardcoded — `sitemapListed: false` and `lastModified: null` —
  // which made 30 of scoreAiCrawler's 100 points unreachable and pinned every freshness score
  // at 0. See docs/audit/01-crawler.md F1/F2 and docs/audit/02-grading.md G7.
  const sitemapListed = sitemapListsAuditedDomain(
    input.sitemapUrls ?? [],
    input.domainUrl,
  );

  // The freshest date any crawled page publishes, preferring the page the report is about.
  const lastModified = pages.reduce<string | null>(
    (acc, page) => newerDate(acc, page.lastModified ?? null),
    primary?.lastModified ?? null,
  );

  if (!primary) {
    return {
      url: input.domainUrl,
      htmlSnapshot: '',
      schemaMarkup: [],
      internalLinks: [],
      externalLinks: [],
      wordCount: 0,
      lastModified,
      robotsTxtAllowsAI,
      sitemapListed,
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
    lastModified,
    robotsTxtAllowsAI,
    sitemapListed,
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
