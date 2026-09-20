/** Did the AI-visibility probe run? 'unavailable' means ai_citation is NOT in the score. */
export type AiProbeStatus = 'ok' | 'unavailable';

export interface Signal {
  label: string;
  value: string | number | boolean;
  pass: boolean;
}

export interface RawFindings {
  url: string;
  htmlSnapshot: string;
  schemaMarkup: string[];
  internalLinks: string[];
  externalLinks: string[];
  wordCount: number;
  lastModified: string | null;
  robotsTxtAllowsAI: boolean;
  sitemapListed: boolean;
  canonicalUrl: string | null;
  openGraphPresent: boolean;
  structuredDataTypes: string[];

  /* Whether the AI-visibility probe actually ran, and what it found.
   *
   * Optional because 290 rows were written before these existed. A reader must treat
   * `undefined` as "unknown", NOT as "ok" — the historical rows are precisely the ones where
   * the probe most often did not run, so defaulting the missing case to ok would hide the
   * reports this was added to explain.
   *
   * These live in raw_findings (JSONB) rather than columns of their own so the fix ships
   * without waiting on a migration to a production database somebody else owns. Promoting
   * them to real columns is a follow-up, worth doing for queryability. */
  aiProbeStatus?: AiProbeStatus;
  /** null when the probe did not run. 0 is a real answer: cited nowhere. */
  aiCitationScore?: number | null;
  aiPromptsTotal?: number;
  aiCitedCount?: number;
}

export interface CrawledPage {
  url: string;
  findings: RawFindings;
  crawledAt: string;
}

export interface AuditRequest {
  url: string;
  email?: string;
}

export interface Lead {
  email: string;
  url: string;
  capturedAt: string;
}

export interface AuditScores {
  ai_crawler: number;
  schema: number;
  content_structure: number;
  authority: number;
  freshness: number;
  overall: number;
}

export interface AuditGrades {
  ai_crawler: string;
  schema: string;
  content_structure: string;
  authority: string;
  freshness: string;
  overall: string;
}

export interface AuditResult {
  id: string;
  url: string;
  requestedAt: string;
  crawledPage: CrawledPage;
  scores: AuditScores;
  grades: AuditGrades;
  insights: string[];
  lead?: Lead;
}

export interface CrawlPage {
  url: string;
  statusCode: number;
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  h2s: string[];
  bodyText: string;
  wordCount: number;
  internalLinks: string[];
  externalLinks: string[];
  hasStructuredData: boolean;
  structuredDataTypes: string[];
  canonicalUrl: string | null;
  robotsMeta: string | null;
  openGraphTags: Record<string, string>;
  fetchError: string | null;
}

export interface CrawlRobotsData {
  raw: string;
  gptBotDisallowed: boolean;
  claudeBotDisallowed: boolean;
  googlebotDisallowed: boolean;
  bingbotDisallowed: boolean;
  fullDisallowAll: boolean;
}
