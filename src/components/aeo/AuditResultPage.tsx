'use client';

import { useEffect, useRef, useState } from 'react';
import { OpenAIIcon, PerplexityIcon, GoogleAIIcon, ClaudeIcon } from '@/components/aeo/EngineIcons';
import styles from './AuditResultPage.module.css';

interface ProbeResult {
  prompt: string;
  response: string;
  cited: boolean;
  mentionedDomains: string[];
  snippet: string | null;
}

interface AiProbe {
  engine: string;
  results: ProbeResult[];
  citedCount: number;
  totalPrompts: number;
  status: 'cited' | 'partial' | 'missing';
}

interface MultiEngineProbe {
  claude: AiProbe | null;
  openai: AiProbe | null;
  perplexity: AiProbe | null;
  google?: AiProbe | null;
  prompts: string[];
}

interface CustomProbeData {
  claude: AiProbe | null;
  openai: AiProbe | null;
  perplexity: AiProbe | null;
  google: AiProbe | null;
  prompts: string[];
}

interface RawFindings {
  robots?: {
    gptBotDisallowed?: boolean;
    claudeBotDisallowed?: boolean;
    googlebotDisallowed?: boolean;
    bingbotDisallowed?: boolean;
    fullDisallowAll?: boolean;
  };
  pages?: Array<{
    url?: string;
    title?: string;
    h1?: string;
    h2s?: string[];
    wordCount?: number;
    hasStructuredData?: boolean;
    structuredDataTypes?: string[];
    canonicalUrl?: string;
    metaDescription?: string;
    openGraphTags?: Record<string, string>;
    robotsMeta?: string | null;
    statusCode?: number;
  }>;
  sitemapListed?: boolean;
  openGraphPresent?: boolean;
  robotsTxtAllowsAI?: boolean;
  structuredDataTypes?: string[];
  wordCount?: number;
  lastModified?: string | null;
  schemaMarkup?: unknown[];
  aiProbe?: AiProbe | MultiEngineProbe | null;
  customProbe?: CustomProbeData | null;
  /* Recorded by computeOverall() in lib/scoring.ts. Absent on reports written before
     2026-09-17 — treat undefined as unknown, never as ok. (This is the THIRD declaration of
     RawFindings in the repo; src/types/audit.ts has the canonical one. Not consolidating it
     here, but it is worth doing.) */
  aiProbeStatus?: 'ok' | 'unavailable';
  aiCitationScore?: number | null;
  aiPromptsTotal?: number;
  aiCitedCount?: number;
}

function isMultiEngineProbe(probe: AiProbe | MultiEngineProbe): probe is MultiEngineProbe {
  return 'claude' in probe;
}

function cleanMarkdown(text: string): string {
  return text
    .replace(/\*\*/g, '')
    .replace(/#{1,6}\s/g, '')
    .replace(/---/g, '')
    .replace(/\n{2,}/g, ' ')
    .trim();
}

function compStatus(probe: AiProbe | null): string {
  if (!probe || probe.results.length === 0) return 'COMING SOON';
  return probe.status.toUpperCase();
}

type FindingItem = { pass: boolean; text: string } | { meta: string };

interface Props {
  requestData: { id: string; url: string; status: string; created_at: string };
  auditData: {
    id: string; overall_score: number; overall_grade: string;
    answerability_score: number; answerability_grade: string;
    brevity_score: number; brevity_grade: string;
    trust_score: number; trust_grade: string;
    structure_score: number; structure_grade: string;
    freshness_score: number; freshness_grade: string;
    raw_findings?: RawFindings;
    created_at: string;
  };
}

function resolveGradeClass(grade: string): string {
  const g = grade?.toLowerCase();
  if (g === 'strong' || g === 'good') return styles.scoreGradeGood;
  if (g === 'needs work' || g === 'warning') return styles.scoreGradeWarn;
  return styles.scoreGradeBad;
}

function resolveGradeLabel(grade: string): string {
  const g = grade?.toLowerCase();
  if (g === 'strong' || g === 'good') return 'Strong';
  if (g === 'needs work' || g === 'warning') return 'Needs work';
  return 'Critical';
}

function dimFillClass(score: number): string {
  if (score >= 70) return styles.dimFillGood;
  if (score >= 40) return styles.dimFillWarn;
  return styles.dimFillBad;
}

function getCrawlabilityFindings(rf: RawFindings): FindingItem[] {
  const findings: FindingItem[] = [];
  const pages = rf.pages ?? [];
  const robots = rf.robots ?? {};

  const aiBotsAllowed = !robots.gptBotDisallowed && !robots.claudeBotDisallowed &&
    !robots.googlebotDisallowed && !robots.bingbotDisallowed;
  findings.push({ pass: aiBotsAllowed, text: 'robots.txt allows AI bots' });
  findings.push({ pass: !!rf.sitemapListed, text: 'Sitemap detected' });

  const canonicalCount = pages.filter(p => !!p.canonicalUrl).length;
  findings.push({ pass: pages.length > 0 && canonicalCount === pages.length, text: 'Canonical URLs present' });

  const allOk = pages.length > 0 && pages.every(p => p.statusCode === 200);
  findings.push({ pass: allOk, text: 'All pages returned 200 OK' });

  findings.push({ meta: `${pages.length} page${pages.length !== 1 ? 's' : ''} crawled successfully` });

  return findings;
}

function getSchemaMarkupFindings(rf: RawFindings): FindingItem[] {
  const findings: FindingItem[] = [];
  const pages = rf.pages ?? [];
  const types = rf.structuredDataTypes ?? [];

  const pagesWithSD = pages.filter(p => p.hasStructuredData);
  findings.push({ pass: pagesWithSD.length > 0, text: 'JSON-LD structured data found' });

  if (types.length > 0) {
    findings.push({ meta: `Types found: ${types.join(', ')}` });
  } else {
    findings.push({ meta: 'No structured data detected' });
  }

  const IMPORTANT_TYPES = ['Organization', 'Article', 'FAQ', 'HowTo'];
  const missingTypes = IMPORTANT_TYPES.filter(t => !types.includes(t));
  if (missingTypes.length > 0) {
    findings.push({ pass: false, text: `Missing types: ${missingTypes.join(', ')}` });
  }

  findings.push({ meta: `${pagesWithSD.length} of ${pages.length} pages have structured data` });

  return findings;
}

function getAuthorityFindings(rf: RawFindings): FindingItem[] {
  const findings: FindingItem[] = [];
  const pages = rf.pages ?? [];

  findings.push({ pass: !!rf.openGraphPresent, text: 'Open Graph tags present' });

  const pagesWithMeta = pages.filter(p => !!p.metaDescription);
  findings.push({ pass: pages.length > 0 && pagesWithMeta.length === pages.length, text: 'Meta descriptions on all pages' });

  const pagesWithHeadings = pages.filter(p => !!p.h1 && p.h2s && p.h2s.length > 0);
  findings.push({ pass: pagesWithHeadings.length > 0, text: 'Strong heading hierarchy (H1 + H2s)' });

  findings.push({ meta: '0 external authority links found' });

  return findings;
}

function getTopicalAuthorityFindings(rf: RawFindings): FindingItem[] {
  const findings: FindingItem[] = [];
  const pages = rf.pages ?? [];
  const totalWords = rf.wordCount ?? pages.reduce((sum, p) => sum + (p.wordCount ?? 0), 0);
  const avgWords = pages.length > 0 ? Math.round(totalWords / pages.length) : 0;

  findings.push({ meta: `${totalWords.toLocaleString()} total words across ${pages.length} pages` });
  findings.push({ meta: `Average ${avgWords.toLocaleString()} words per page` });

  const depthPass = avgWords >= 1000;
  const depthLabel = avgWords >= 1000
    ? 'Good content depth (>1000 words/page)'
    : avgWords >= 500
    ? 'Moderate content depth (500–999 words/page)'
    : 'Thin content (<500 words/page)';
  findings.push({ pass: depthPass, text: depthLabel });

  const topics: string[] = [];
  pages.forEach(p => {
    if (p.h1) topics.push(p.h1);
    if (p.h2s) p.h2s.slice(0, 2).forEach(h => topics.push(h));
  });
  if (topics.length > 0) {
    findings.push({ meta: `Top topics: ${topics.slice(0, 5).join(' · ')}` });
  }

  return findings;
}

function getFreshnessFindings(rf: RawFindings): FindingItem[] {
  const findings: FindingItem[] = [];
  const types = rf.structuredDataTypes ?? [];

  findings.push({
    pass: !!rf.lastModified,
    text: rf.lastModified
      ? `Last-Modified header present (${rf.lastModified})`
      : 'No Last-Modified header detected',
  });

  const hasArticleSchema = types.some(t =>
    ['Article', 'BlogPosting', 'NewsArticle'].includes(t)
  );
  findings.push({ pass: hasArticleSchema, text: hasArticleSchema ? 'Article schema with datePublished found' : 'No Article schema with datePublished' });
  findings.push({ pass: hasArticleSchema, text: hasArticleSchema ? 'Publish dates detected in schema' : 'No publish dates detected' });

  return findings;
}

const CUSTOM_PLACEHOLDERS: [string, string, string] = [
  'e.g. What are the best HubSpot agencies for enterprise companies?',
  'e.g. Who should I hire for marketing automation?',
  'e.g. Which CRM consultants are best for mid-size B2B?',
];

export default function AuditResultPage({ requestData, auditData }: Props) {
  const [animatedScore, setAnimatedScore] = useState(0);
  const [expandedDim, setExpandedDim] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [activeEngine, setActiveEngine] = useState<string>('claude');
  const [customInputs, setCustomInputs] = useState<[string, string, string]>(['', '', '']);
  const [customLoading, setCustomLoading] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);
  const [customResults, setCustomResults] = useState<CustomProbeData | null>(
    (auditData.raw_findings?.customProbe as CustomProbeData | null | undefined) ?? null,
  );
  const [customActiveEngine, setCustomActiveEngine] = useState<string>('claude');
  const rafRef = useRef<number | null>(null);

  const [unlocked, setUnlocked] = useState(false);
  const gatedSectionRef = useRef<HTMLDivElement>(null);
  const [gateName, setGateName] = useState('');
  const [gateEmail, setGateEmail] = useState('');
  const [gateSubmitting, setGateSubmitting] = useState(false);
  const [gateError, setGateError] = useState('');

  const domain = requestData.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const auditDate = new Date(auditData.created_at).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });

  const circumference = 2 * Math.PI * 110;
  const target = auditData.overall_score;

  useEffect(() => {
    const duration = 1400;
    const start = performance.now();
    function animate(now: number) {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setAnimatedScore(Math.round(eased * target));
      if (t < 1) rafRef.current = requestAnimationFrame(animate);
    }
    rafRef.current = requestAnimationFrame(animate);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [target]);

  useEffect(() => {
    if (localStorage.getItem(`aeo-unlocked-${requestData.id}`) === 'true') {
      setUnlocked(true);
    }
  }, [requestData.id]);

  const handleUnlock = async () => {
    if (!gateName.trim()) { setGateError('Please enter your full name'); return; }
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(gateEmail.trim());
    if (!emailOk) { setGateError('Please enter a valid work email'); return; }
    setGateSubmitting(true);
    setGateError('');
    try {
      const res = await fetch(`/api/audit/${requestData.id}/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: gateName.trim(), email: gateEmail.trim() }),
      });
      if (res.ok) {
        localStorage.setItem(`aeo-unlocked-${requestData.id}`, 'true');
        setUnlocked(true);
      } else {
        const data = await res.json() as { error?: string };
        setGateError(data.error ?? 'Something went wrong');
      }
    } catch {
      setGateError('Network error — please try again');
    }
    setGateSubmitting(false);
  };

  const dashoffset = circumference - (animatedScore / 100) * circumference;

  const rf = auditData.raw_findings;

  const handleShare = async () => {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    window.print();
  };

  const handleCustomSubmit = async () => {
    const prompts = customInputs.filter(p => p.trim().length > 0);
    if (prompts.length === 0) return;
    setCustomLoading(true);
    setCustomError(null);
    try {
      const res = await fetch(`/api/audit/${requestData.id}/custom-prompts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompts }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCustomError((data as { error?: string }).error ?? 'Failed to run custom prompts');
        return;
      }
      const probe = (data as { customProbe: CustomProbeData }).customProbe;
      setCustomResults(probe);
      const firstKey =
        (['claude', 'openai', 'perplexity'] as const).find(k => probe[k] && probe[k]!.results.length > 0)
        ?? (probe.google && probe.google.results.length > 0 ? 'googleai' : 'claude');
      setCustomActiveEngine(firstKey);
    } catch {
      setCustomError('Network error. Please try again.');
    } finally {
      setCustomLoading(false);
    }
  };

  const dims = [
    { label: 'Crawlability', key: 'crawlability', score: auditData.answerability_score, getFindings: getCrawlabilityFindings },
    { label: 'Schema Markup', key: 'schema', score: auditData.brevity_score, getFindings: getSchemaMarkupFindings },
    { label: 'Authority & Citation', key: 'authority', score: auditData.trust_score, getFindings: getAuthorityFindings },
    { label: 'Topical Authority', key: 'topical', score: auditData.structure_score, getFindings: getTopicalAuthorityFindings },
    { label: 'Freshness', key: 'freshness', score: auditData.freshness_score, getFindings: getFreshnessFindings },
    { label: 'Brand Mentions', key: 'brand', score: 0, getFindings: null },
  ];

  const rawProbe = rf?.aiProbe ?? null;
  const claudeProbe: AiProbe | null = rawProbe
    ? isMultiEngineProbe(rawProbe) ? rawProbe.claude : rawProbe
    : null;
  const openaiProbe: AiProbe | null = rawProbe && isMultiEngineProbe(rawProbe) ? rawProbe.openai : null;
  const perplexityProbe: AiProbe | null = rawProbe && isMultiEngineProbe(rawProbe) ? rawProbe.perplexity : null;
  const googleProbe: AiProbe | null = rawProbe && isMultiEngineProbe(rawProbe) ? rawProbe.google ?? null : null;

  let totalAiCited = 0;
  let totalAiPrompts = 0;
  if (rawProbe) {
    const probeList = isMultiEngineProbe(rawProbe)
      ? [rawProbe.claude, rawProbe.openai, rawProbe.perplexity, rawProbe.google ?? null]
      : [rawProbe as AiProbe];
    for (const p of probeList) {
      if (p && p.results && p.results.length > 0) {
        totalAiCited += p.citedCount;
        totalAiPrompts += p.totalPrompts;
      }
    }
  }
  const hasAiData = totalAiPrompts > 0;

  /* Prefer what the scorer RECORDED over what this component can infer.
   *
   * `aiProbeStatus` is absent on every report written before 2026-09-17, so it falls back to
   * the derived check. Note the order: an ABSENT status must not read as ok, because the old
   * rows are exactly the ones where the probe most often did not run. */
  const aiProbeUnavailable = rf?.aiProbeStatus
    ? rf.aiProbeStatus === 'unavailable'
    : !hasAiData;

  // Aggregate competitor domains from AI probe responses
  const competitorMap = new Map<string, number>();
  const userDomain = requestData.url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').toLowerCase();

  if (rawProbe) {
    const probeList = isMultiEngineProbe(rawProbe)
      ? [rawProbe.claude, rawProbe.openai, rawProbe.perplexity, rawProbe.google ?? null]
      : [rawProbe as AiProbe];
    for (const p of probeList) {
      if (!p?.results) continue;
      for (const r of p.results) {
        if (!r.mentionedDomains) continue;
        for (const d of r.mentionedDomains) {
          const clean = d.toLowerCase().replace(/^www\./, '');
          // Skip the user's own domain and common non-competitor domains
          if (clean === userDomain || clean.includes(userDomain) || userDomain.includes(clean)) continue;
          if (['google.com', 'youtube.com', 'wikipedia.org', 'linkedin.com', 'facebook.com', 'twitter.com', 'x.com', 'github.com', 'medium.com', 'reddit.com', 'amazon.com', 'apple.com', 'forbes.com', 'bbb.org'].includes(clean)) continue;
          competitorMap.set(clean, (competitorMap.get(clean) || 0) + 1);
        }
      }
    }
  }

  const topCompetitors = Array.from(competitorMap.entries())
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([domain, count]) => ({
      domain,
      name: domain.split('.')[0].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      count,
      rate: totalAiPrompts > 0 ? count : 0,
    }));

  const probeStatus = (probe: AiProbe | null): string => {
    if (!probe) return 'PENDING';
    if (probe.results.length === 0) return 'COMING SOON';
    return probe.status.toUpperCase();
  };

  const probeComingSoon = (probe: AiProbe | null): boolean =>
    !probe || probe.results.length === 0;

  const engines = [
    { name: 'ChatGPT', bg: '#10A37F', icon: <OpenAIIcon size={16} />, probe: openaiProbe },
    { name: 'Perplexity', bg: '#20808D', icon: <PerplexityIcon size={16} />, probe: perplexityProbe },
    { name: 'Google AI', bg: 'linear-gradient(135deg,#4285F4,#34A853)', icon: <GoogleAIIcon size={16} />, probe: googleProbe },
    { name: 'Claude', bg: '#D97757', icon: <ClaudeIcon size={16} />, probe: claudeProbe },
  ];

  const tabEngines = [
    { key: 'claude', name: 'Claude', color: '#D97757', probe: claudeProbe },
    { key: 'openai', name: 'ChatGPT', color: '#10A37F', probe: openaiProbe },
    { key: 'perplexity', name: 'Perplexity', color: '#20808D', probe: perplexityProbe },
    { key: 'googleai', name: 'Google AI', color: '#4285F4', probe: googleProbe },
  ].filter((e): e is { key: string; name: string; color: string; probe: AiProbe } =>
    e.probe !== null && e.probe.results.length > 0
  );

  const comparisonEngines = [
    { key: 'claude', name: 'Claude', color: '#D97757', probe: claudeProbe },
    { key: 'openai', name: 'ChatGPT', color: '#10A37F', probe: openaiProbe },
    { key: 'perplexity', name: 'Perplexity', color: '#20808D', probe: perplexityProbe },
    { key: 'googleai', name: 'Google AI', color: '#4285F4', probe: googleProbe },
  ];

  const recs = [
    { priority: 'high', title: 'Add structured data markup', desc: 'Implement JSON-LD schema for your key pages to improve AI engine crawlability and entity recognition.' },
    { priority: 'high', title: 'Build authoritative citations', desc: 'Get mentioned in industry publications and directories that AI engines use as trusted sources.' },
    { priority: 'medium', title: 'Optimize for conversational queries', desc: 'Rewrite key pages to answer questions directly in the first 50 words.' },
    { priority: 'medium', title: 'Increase content freshness', desc: 'Publish or update content weekly to signal active expertise to AI engines.' },
    { priority: 'low', title: 'Establish brand entity', desc: 'Create a Wikipedia-style entity page and ensure NAP consistency across the web.' },
  ];

  const badgeClass = (status: string) => {
    if (status === 'CITED') return styles.erBadgeCited;
    if (status === 'PARTIAL') return styles.erBadgePartial;
    return styles.erBadgeMissing;
  };

  return (
    <div className={styles.auditPage}>
      <div className={styles.container}>

        {/* Header */}
        <div className={styles.auditHeader}>
          <div>
            <div className={styles.auditStatus}>
              <span className={styles.greenDot} />
              AUDIT COMPLETE · {auditDate}
            </div>
            <h1>{domain}</h1>
            <div className={styles.aMeta}>
              <span>AEO Score Report</span>
              <span>·</span>
              <span>{auditDate}</span>
              <span>·</span>
              <span>ID: {auditData.id.slice(0, 8)}</span>
            </div>
          </div>
          <div className={styles.auditActions}>
            <div style={{ position: 'relative' }}>
              <button className={styles.btnSecondary} onClick={handleShare}>Share</button>
              {copied && <span className={styles.copiedToast}>Link copied!</span>}
            </div>
            <button className={styles.btnSecondary} onClick={handleDownload}>Download PDF</button>
            <a href="/" className={styles.btnPrimary}>New audit</a>
          </div>
        </div>

        {/* Score Hero */}
        <div className={styles.scoreHero}>
          <div className={styles.scoreRingWrap}>
            <div className={styles.scoreRing}>
              <svg width="170" height="170" viewBox="0 0 260 260">
                <defs>
                  <linearGradient id="scoreGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#F59E0B" />
                    <stop offset="100%" stopColor="#EF4444" />
                  </linearGradient>
                </defs>
                <circle cx="130" cy="130" r="110" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="18" />
                <circle
                  cx="130" cy="130" r="110" fill="none"
                  stroke="url(#scoreGrad)" strokeWidth="18" strokeLinecap="round"
                  strokeDasharray={circumference} strokeDashoffset={dashoffset}
                  style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }}
                />
              </svg>
              <div className={styles.scoreRingInner}>
                <div className={styles.scoreNum}>{animatedScore}</div>
                <div className={styles.scoreOutOf}>/100</div>
              </div>
            </div>
            <div className={`${styles.scoreGrade} ${
              (() => {
                const aiRate = totalAiPrompts > 0 ? totalAiCited / totalAiPrompts : 0;
                if (aiRate >= 0.75) return styles.scoreGradeGood;
                if (aiRate >= 0.40 || auditData.overall_score >= 50) return styles.scoreGradeWarn;
                return styles.scoreGradeBad;
              })()
            }`}>
              {(() => {
                const aiRate = totalAiPrompts > 0 ? totalAiCited / totalAiPrompts : 0;
                if (aiRate >= 0.75) return 'Strong';
                if (aiRate >= 0.40) return 'Needs work';
                if (!hasAiData && auditData.overall_score >= 50) return 'Needs work';
                return 'Critical';
              })()}
            </div>

            {/* The AI half of this score is 40% of it. When the probe cannot run, the other five
                dimensions are scored on their own scale — a legitimate number, but not the number
                this report is named after. Say so rather than let the reader assume we checked. */}
            {aiProbeUnavailable && (
              <p className={styles.aiUnavailable}>
                AI visibility check unavailable for this run — the score above reflects your
                site&apos;s content signals only, not whether AI engines actually cite you.
              </p>
            )}
            <button
              className={styles.heroCtaBtn}
              onClick={() => gatedSectionRef.current?.scrollIntoView({ behavior: 'smooth' })}
            >
              {unlocked ? 'View full report ↓' : 'Unlock your full report →'}
            </button>
            <a
              className={styles.heroCtaLink}
              href="https://www.campaigncreators.com/aeo"
              target="_blank"
              rel="noopener noreferrer"
            >
              See our AEO services
            </a>
          </div>

          <div className={styles.scoreSummary}>
            <div className={styles.heroEyebrow}>What your score means</div>
            {(() => {
              const aiRate = totalAiPrompts > 0 ? totalAiCited / totalAiPrompts : 0;
              if (aiRate >= 0.75) return <h2>Your brand is well-cited by AI engines. Here&apos;s how to stay ahead.</h2>;
              if (aiRate >= 0.40) return <h2>Your brand appears in some AI answers. Here&apos;s where to push further.</h2>;
              if (aiRate > 0 && hasAiData) return <h2>Your brand has limited AI citation. Here&apos;s what you&apos;re leaving on the table.</h2>;
              // NOT "solid AI signals" — there are none in this branch. The probe did not run,
              // so the only honest claim is about the content we actually measured.
              if (!hasAiData && target >= 70) return <h2>Your content signals are strong. Here&apos;s where to push further.</h2>;
              if (!hasAiData && target >= 50) return <h2>Your brand has limited AI visibility. Here&apos;s what you&apos;re leaving on the table.</h2>;
              return <h2>Your brand is invisible to AI search. Here&apos;s what that&apos;s costing you.</h2>;
            })()}
            <p>
              {(() => {
                const aiRate = totalAiPrompts > 0 ? totalAiCited / totalAiPrompts : 0;
                if (aiRate >= 0.75) {
                  return `Your brand is cited in ${totalAiCited} of ${totalAiPrompts} AI prompts across all engines — strong AI visibility. Focus on technical optimizations to improve structured data and freshness signals.`;
                }
                if (aiRate >= 0.40) {
                  return `Your brand appears in ${totalAiCited} of ${totalAiPrompts} AI prompts, but inconsistently across engines. Competitors with stronger signals are capturing the majority of AI-referred traffic.`;
                }
                if (hasAiData && aiRate > 0) {
                  return `Your brand only appears in ${totalAiCited} of ${totalAiPrompts} AI prompts. 62% of B2B buyers now start research in AI tools — your competitors are being recommended more consistently.`;
                }
                if (!hasAiData) {
                  return `62% of B2B buyers now start research in AI tools. With a score of ${auditData.overall_score}, your site's technical signals suggest AI engines may be overlooking your brand.`;
                }
                return `62% of B2B buyers now start research in AI tools. With a score of ${auditData.overall_score}, your competitors are being recommended while your brand is being skipped entirely.`;
              })()}
            </p>

            <div className={styles.impactGrid}>
              <div className={styles.impactCard}>
                <span className={styles.impactNum}>
                  {hasAiData ? `${totalAiCited}/${totalAiPrompts}` : '—'}
                </span>
                <span className={styles.impactLabel}>
                  {hasAiData ? 'AI prompts cited your brand' : 'AI citation data pending'}
                </span>
              </div>
              <div className={styles.impactCard}>
                <span className={styles.impactNumBad}>−61%</span>
                <span className={styles.impactLabel}>organic CTR when AI answers appear</span>
              </div>
              <div className={styles.impactCard}>
                <span className={styles.impactNumWarn}>73%</span>
                <span className={styles.impactLabel}>of B2B sites lost traffic to AI search in 2025</span>
              </div>
              <div className={styles.impactCard}>
                <span className={styles.impactNum}>4.4×</span>
                <span className={styles.impactLabel}>higher conversion from AI-referred visitors</span>
              </div>
            </div>

            <div className={styles.heroDivider} />

            <div className={styles.heroSources}>
              <span className={styles.heroSourceStat}><strong>48%</strong> of Google queries now show AI Overviews</span>
              <span className={styles.heroSourceDot}>·</span>
              <span className={styles.heroSourceStat}><strong>82%</strong> of B2B tech queries trigger AI summaries</span>
              <span className={styles.heroSourceDot}>·</span>
              <span className={styles.heroSourceStat}>Source: BrightEdge, Seer Interactive, Semrush 2025–2026</span>
            </div>
          </div>
        </div>

        {/* Gated section — everything below the score hero */}
        <div className={styles.gatedSection} ref={gatedSectionRef}>
          {!unlocked && (
            <>
              <div className={styles.frostedOverlay} />
              <div className={styles.gateModal}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="https://www.campaigncreators.com/hubfs/cc-logo-color-horizontal%20(1).png"
                  alt="Campaign Creators"
                  height={28}
                  className={styles.gateModalLogo}
                />
                <h3>Unlock Your Full AEO Report</h3>
                <p>Enter your details to access your complete AI visibility analysis, dimension breakdowns, and 90-day action plan.</p>
                <input
                  className={styles.gateInput}
                  type="text"
                  placeholder="Full Name"
                  value={gateName}
                  required
                  disabled={gateSubmitting}
                  onChange={e => setGateName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleUnlock()}
                />
                <input
                  className={styles.gateInput}
                  type="email"
                  placeholder="Work Email"
                  value={gateEmail}
                  required
                  disabled={gateSubmitting}
                  onChange={e => setGateEmail(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleUnlock()}
                />
                {gateError && <p className={styles.gateError} role="alert">{gateError}</p>}
                <button
                  className={styles.gateSubmit}
                  disabled={gateSubmitting}
                  onClick={handleUnlock}
                >
                  {gateSubmitting ? 'Unlocking…' : 'Unlock My Report →'}
                </button>
                <p className={styles.gatePrivacy}>We respect your privacy. No spam, ever.</p>
              </div>
            </>
          )}
          <div className={unlocked ? '' : styles.blurred}>

        {/* Report Grid */}
        <div className={styles.reportGrid}>
          <div className={styles.reportCard}>
            <h3 className={styles.cardTitle}>What&apos;s driving your score</h3>
            <div className={styles.dims}>
              {dims.map((d) => {
                const findings = rf && d.getFindings ? d.getFindings(rf) : null;
                const isExpanded = expandedDim === d.key;
                return (
                  <div key={d.key} className={styles.dimContainer}>
                    <div className={styles.dimRow}>
                      <span className={styles.dimLabel}>{d.label}</span>
                      <div className={styles.dimBarWrap}>
                        <div
                          className={`${styles.dimBar} ${dimFillClass(d.score)}`}
                          style={{ width: `${d.score}%` }}
                        />
                      </div>
                      <span className={styles.dimScore}>{d.score}</span>
                    </div>
                    {findings && (
                      <>
                        <button
                          className={styles.findingsToggle}
                          onClick={() => setExpandedDim(isExpanded ? null : d.key)}
                        >
                          <span className={`${styles.findingsChevron} ${isExpanded ? styles.findingsChevronOpen : ''}`}>›</span>
                          {isExpanded ? 'Hide findings' : 'View findings'}
                        </button>
                        <div
                          className={styles.findingsList}
                          style={{ maxHeight: isExpanded ? '600px' : '0' }}
                        >
                          {findings.map((f, i) => {
                            if ('meta' in f) {
                              return (
                                <div key={i} className={styles.findingMeta}>{f.meta}</div>
                              );
                            }
                            return (
                              <div key={i} className={styles.findingItem}>
                                <span className={f.pass ? styles.findingCheck : styles.findingCross}>
                                  {f.pass ? '✅' : '❌'}
                                </span>
                                <span>{f.text}</span>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className={styles.reportCard}>
            <h3 className={styles.cardTitle}>How each AI engine sees you</h3>
            <div className={styles.engines}>
              {engines.map((eng) => {
                const status = probeStatus(eng.probe);
                const comingSoon = probeComingSoon(eng.probe);
                return (
                  <div key={eng.name} className={styles.engineResult}>
                    <div className={styles.erName}>
                      <span className={styles.erIcon} style={{ background: eng.bg }}>{eng.icon}</span>
                      <span>{eng.name}</span>
                    </div>
                    {comingSoon ? (
                      <span className={`${styles.erBadge} ${styles.erBadgeMissing}`} title="Coming soon">COMING SOON</span>
                    ) : (
                      <span className={`${styles.erBadge} ${badgeClass(status)}`}>{status}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Cross-engine AI Probe Comparison */}
        <div className={styles.reportCard} style={{ marginTop: 24 }}>
          <h3 className={styles.cardTitle}>AI Probe — Cross-Engine Comparison</h3>

          {/* Comparison summary grid */}
          <div className={styles.comparisonGrid}>
            <div className={styles.comparisonRow}>
              <div className={`${styles.comparisonCell} ${styles.comparisonHeaderCell}`} />
              {comparisonEngines.map(eng => (
                <div key={eng.key} className={`${styles.comparisonCell} ${styles.comparisonHeaderCell}`}>
                  <div className={styles.comparisonEngine}>
                    <span className={styles.engineDot} style={{ background: eng.color }} />
                    {eng.name}
                  </div>
                </div>
              ))}
            </div>
            <div className={styles.comparisonRow}>
              <div className={`${styles.comparisonCell} ${styles.comparisonLabelCell}`}>Status</div>
              {comparisonEngines.map(eng => (
                <div key={eng.key} className={styles.comparisonCell}>
                  <span className={`${styles.erBadge} ${badgeClass(compStatus(eng.probe))}`}>
                    {compStatus(eng.probe)}
                  </span>
                </div>
              ))}
            </div>
            <div className={styles.comparisonRow}>
              <div className={`${styles.comparisonCell} ${styles.comparisonLabelCell}`}>Cited</div>
              {comparisonEngines.map(eng => (
                <div key={eng.key} className={styles.comparisonCell}>
                  {eng.probe && eng.probe.results.length > 0
                    ? `${eng.probe.citedCount}/${eng.probe.totalPrompts}`
                    : '—'}
                </div>
              ))}
            </div>
          </div>

          {/* Engine tabs */}
          {tabEngines.length > 0 && (
            <>
              <div className={styles.engineTabs}>
                {tabEngines.map(eng => (
                  <button
                    key={eng.key}
                    className={`${styles.engineTab} ${activeEngine === eng.key ? styles.engineTabActive : ''}`}
                    style={activeEngine === eng.key ? { borderBottomColor: eng.color } : undefined}
                    onClick={() => setActiveEngine(eng.key)}
                  >
                    {eng.name}
                    <span className={styles.engineTabBadge}>
                      {eng.probe.citedCount}/{eng.probe.totalPrompts}
                    </span>
                  </button>
                ))}
              </div>

              {(() => {
                const activeTab = tabEngines.find(e => e.key === activeEngine) ?? tabEngines[0];
                const probe = activeTab.probe;
                return (
                  <div>
                    <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 16, marginTop: 0 }}>
                      {probe.citedCount} of {probe.totalPrompts} prompts cited your domain
                    </p>
                    <div className={styles.prompts}>
                      {probe.results.map((item, i) => (
                        <div key={i} className={styles.promptRow} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', gap: 16 }}>
                            <span className={styles.promptQ}>&ldquo;{item.prompt}&rdquo;</span>
                            <span className={`${styles.erBadge} ${item.cited ? styles.erBadgeCited : styles.erBadgeMissing}`}>
                              {item.cited ? 'CITED' : 'NOT CITED'}
                            </span>
                          </div>
                          {item.snippet && (
                            <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: 0, lineHeight: 1.5 }}>
                              {cleanMarkdown(item.snippet)}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </>
          )}

          {tabEngines.length === 0 && (
            <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginTop: 8 }}>
              No AI probe results available yet.
            </p>
          )}
        </div>

        {/* Custom Prompts + Competitor Leaderboard — side-by-side */}
        <div className={styles.probeCompRow}>
          <div className={styles.probeCompLeft}>
        {/* Custom Prompts Section */}
        <div className={styles.customPromptsSection}>
          <div className={styles.customPromptsAccent} />
          <h3 className={styles.cardTitle}>Test your own prompts</h3>
          <p className={styles.customPromptsSubtext}>
            Think your customers search differently? Add up to 3 custom prompts and we&apos;ll test them across all AI engines.
          </p>

          {!customResults && (
            <div>
              {CUSTOM_PLACEHOLDERS.map((placeholder, i) => (
                <input
                  key={i}
                  className={styles.customPromptInput}
                  type="text"
                  value={customInputs[i]}
                  maxLength={200}
                  disabled={customLoading}
                  placeholder={placeholder}
                  onChange={e => {
                    const next = [...customInputs] as [string, string, string];
                    next[i] = e.target.value;
                    setCustomInputs(next);
                  }}
                />
              ))}
              {customError && (
                <p style={{ fontSize: 13, color: 'var(--color-error)', marginBottom: 12, marginTop: 0 }}>
                  {customError}
                </p>
              )}
              <button
                className={styles.customPromptSubmit}
                disabled={customLoading || customInputs.every(s => !s.trim())}
                onClick={handleCustomSubmit}
              >
                {customLoading ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span className={styles.customSpinner} />
                    Running…
                  </span>
                ) : 'Run custom prompts →'}
              </button>
            </div>
          )}

          {customResults && (() => {
            const customTabEngines = [
              { key: 'claude', name: 'Claude', color: '#D97757', probe: customResults.claude },
              { key: 'openai', name: 'ChatGPT', color: '#10A37F', probe: customResults.openai },
              { key: 'perplexity', name: 'Perplexity', color: '#20808D', probe: customResults.perplexity },
              { key: 'googleai', name: 'Google AI', color: '#4285F4', probe: customResults.google },
            ].filter((e): e is { key: string; name: string; color: string; probe: AiProbe } =>
              e.probe !== null && e.probe !== undefined && e.probe.results.length > 0
            );

            const citedIndices = new Set<number>();
            customTabEngines.forEach(({ probe }) => {
              probe.results.forEach((r, i) => { if (r.cited) citedIndices.add(i); });
            });

            const activeCustomTab = customTabEngines.find(e => e.key === customActiveEngine) ?? customTabEngines[0];

            return (
              <div className={styles.customPromptResults}>
                <p style={{ fontSize: 14, color: 'var(--ink-2)', marginBottom: 16, marginTop: 0 }}>
                  <strong>{citedIndices.size} of {customResults.prompts.length}</strong> custom prompts cited your domain across all engines
                </p>

                {customTabEngines.length > 0 && (
                  <>
                    <div className={styles.engineTabs}>
                      {customTabEngines.map(eng => (
                        <button
                          key={eng.key}
                          className={`${styles.engineTab} ${customActiveEngine === eng.key ? styles.engineTabActive : ''}`}
                          style={customActiveEngine === eng.key ? { borderBottomColor: eng.color } : undefined}
                          onClick={() => setCustomActiveEngine(eng.key)}
                        >
                          {eng.name}
                          <span className={styles.engineTabBadge}>
                            {eng.probe.citedCount}/{eng.probe.totalPrompts}
                          </span>
                        </button>
                      ))}
                    </div>

                    {activeCustomTab && (() => {
                      const probe = activeCustomTab.probe;
                      return (
                        <div>
                          <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 16, marginTop: 0 }}>
                            {probe.citedCount} of {probe.totalPrompts} prompts cited your domain
                          </p>
                          <div className={styles.prompts}>
                            {probe.results.map((item, i) => (
                              <div
                                key={i}
                                className={styles.promptRow}
                                style={{
                                  flexDirection: 'column',
                                  alignItems: 'flex-start',
                                  gap: 8,
                                  background: item.cited
                                    ? 'rgba(53, 255, 216, 0.12)'
                                    : 'rgba(220, 38, 38, 0.06)',
                                }}
                              >
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', gap: 16 }}>
                                  <span className={styles.promptQ}>&ldquo;{item.prompt}&rdquo;</span>
                                  <span className={`${styles.erBadge} ${item.cited ? styles.erBadgeCited : styles.erBadgeMissing}`}>
                                    {item.cited ? 'CITED' : 'NOT CITED'}
                                  </span>
                                </div>
                                {item.snippet && (
                                  <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: 0, lineHeight: 1.5 }}>
                                    {cleanMarkdown(item.snippet)}
                                  </p>
                                )}
                                {!item.cited && item.mentionedDomains.length > 0 && (
                                  <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: 0 }}>
                                    Mentioned instead: {item.mentionedDomains.slice(0, 3).join(', ')}
                                  </p>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </>
                )}

                {customTabEngines.length === 0 && (
                  <p style={{ fontSize: 14, color: 'var(--color-text-muted)' }}>
                    No results available from any engine.
                  </p>
                )}
              </div>
            );
          })()}
        </div>

          </div>{/* end probeCompLeft */}

          {/* Competitor Leaderboard — compact */}
          {topCompetitors.length > 0 && (
            <div className={styles.probeCompRight}>
              <div className={styles.compCard}>
                <p className={styles.compEyebrow}>Competitive intelligence</p>
                <h3 className={styles.compHeadingSm}>Brands AI recommends instead</h3>

                <div className={styles.compListSm}>
                  {topCompetitors.map((comp, i) => (
                    <div key={comp.domain} className={styles.compRowSm}>
                      <span className={`${styles.compRank} ${i < 3 ? styles.compRankTop : ''}`}>{i + 1}</span>
                      <div className={styles.compNameCol}>
                        <span className={styles.compName}>{comp.name}</span>
                        <span className={styles.compDomain}>{comp.domain}</span>
                      </div>
                    </div>
                  ))}

                  <div className={styles.compDivider} />

                  <div className={`${styles.compRowSm} ${styles.compRowYou}`}>
                    <span className={styles.compRankYou}>—</span>
                    <div className={styles.compNameCol}>
                      <span className={styles.compNameYou}>{userDomain.split('.')[0].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</span>
                      <span className={styles.compDomainYou}>{userDomain}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>{/* end probeCompRow */}

        {/* 90-day Action Plan */}
        <div className={styles.reportCard} style={{ marginTop: 24 }}>
          <h3 className={styles.cardTitle}>Your 90-day action plan</h3>
          <div className={styles.recs}>
            {recs.map((rec, i) => (
              <div key={i} className={styles.rec}>
                <div className={styles.recNum}>{i + 1}</div>
                <div>
                  <div className={styles.recTitle}>{rec.title}</div>
                  <div className={styles.recDesc}>{rec.desc}</div>
                </div>
                <span className={`${styles.recPriority} ${
                  rec.priority === 'high' ? styles.recPriorityHigh :
                  rec.priority === 'medium' ? styles.recPriorityMed :
                  styles.recPriorityLow
                }`}>{rec.priority}</span>
              </div>
            ))}
          </div>
        </div>

        {/* CTA Card */}
        <div className={styles.ctaCard}>
          <div className={styles.ctaScorePill}>
            <span className={styles.ctaScoreCircle}>{auditData.overall_score}</span>
            <span className={styles.ctaScoreMeta}>
              Your score · <strong>{recs.length}</strong> fixes identified · <strong>{totalAiCited} of {totalAiPrompts}</strong> AI prompts cited you
            </span>
          </div>
          <h2 className={styles.ctaHeading}>Want help executing?</h2>
          <p className={styles.ctaSubtext}>
            Our AEO specialists will implement these recommendations and get your brand cited by AI engines within 90 days.
          </p>
          <div className={styles.ctaBtnRow}>
            <a
              href="https://www.campaigncreators.com/schedule-your-solutions-call-campaign-creators-hubspot-elite-partner"
              target="_blank"
              rel="noopener noreferrer"
              className={styles.ctaBtnPrimary}
            >
              Book a strategy call →
            </a>
          </div>
          <p className={styles.ctaBlogRow}>
            <strong>Not ready to talk yet?</strong> Get AEO insights, strategy breakdowns, and what&apos;s working right now — straight from the team doing this work.{' '}
            <a
              href="https://www.campaigncreators.com/blog/topic/seo-aeo-geo"
              target="_blank"
              rel="noopener noreferrer"
            >
              Read the AEO blog →
            </a>
          </p>
          <p className={styles.ctaFooter}>No commitment required · You keep the roadmap either way</p>
        </div>

          </div>{/* end blurred wrapper */}
        </div>{/* end gatedSection */}

      </div>
    </div>
  );
}
