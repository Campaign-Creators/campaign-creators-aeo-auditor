'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './ReportGuide.module.css';

/** Bump the version when the steps change, so returning visitors see the new guide once. */
export const GUIDE_SEEN_KEY = 'aeo-report-guide-v1';

export const GUIDE_STEPS = [
  {
    title: 'Your AEO score',
    text: 'The big number shows how ready your site is to be named in AI answers. It combines how often AI engines cite you with five content checks.',
  },
  {
    title: 'What each AI engine said',
    text: 'See whether ChatGPT, Perplexity, Google AI and Claude mention your brand for the questions your buyers ask.',
  },
  {
    title: 'Unlock the full report',
    text: 'Add your name and work email to see every check, what to fix first, and to test questions of your own.',
  },
] as const;

/** Ships dark: shown only when NEXT_PUBLIC_AEO_GUIDE is exactly "on". */
export function guideEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AEO_GUIDE === 'on';
}

export function shouldAutoOpen(enabled: boolean, seen: string | null): boolean {
  return enabled && !seen;
}

function readSeen(): string | null {
  try { return localStorage.getItem(GUIDE_SEEN_KEY); } catch { return '1'; }
}

function markSeen(): void {
  try { localStorage.setItem(GUIDE_SEEN_KEY, '1'); } catch { /* private mode: shows again next time */ }
}

/** The Tutorials button plus the guide card. Renders nothing when the flag is off. */
export default function ReportGuide({ buttonClassName }: { buttonClassName?: string }) {
  const enabled = guideEnabled();
  const [step, setStep] = useState<number | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!shouldAutoOpen(enabled, readSeen())) return;
    // Let the report paint first; the guide is a second thing to read.
    const t = setTimeout(() => setStep(0), 600);
    return () => clearTimeout(t);
  }, [enabled]);

  useEffect(() => {
    if (step === null) return;
    cardRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  if (!enabled) return null;

  function close() {
    markSeen();
    setStep(null);
  }

  const current = step === null ? null : GUIDE_STEPS[step];
  const last = step === GUIDE_STEPS.length - 1;

  return (
    <>
      <button type="button" className={buttonClassName} onClick={() => setStep(0)}>
        Tutorials
      </button>
      {current && (
        <div
          ref={cardRef}
          className={styles.card}
          role="dialog"
          aria-modal="false"
          aria-labelledby="report-guide-title"
          tabIndex={-1}
        >
          <p className={styles.count}>{step! + 1} of {GUIDE_STEPS.length}</p>
          <h2 id="report-guide-title" className={styles.title}>{current.title}</h2>
          <p className={styles.text}>{current.text}</p>
          <div className={styles.actions}>
            <button type="button" className={styles.skip} onClick={close}>Skip</button>
            {step! > 0 && (
              <button type="button" className={styles.back} onClick={() => setStep(step! - 1)}>Back</button>
            )}
            <button type="button" className={styles.next} onClick={() => (last ? close() : setStep(step! + 1))}>
              {last ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
