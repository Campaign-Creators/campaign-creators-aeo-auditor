'use client';

import { useState, useRef, type FormEvent } from 'react';
import styles from './AuditForm.module.css';
import { staffAuthHeader } from '@/lib/staffClient';

function ArrowIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

function cleanDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function isValidDomain(domain: string): boolean {
  return /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(domain);
}

export function AuditForm() {
  const [domain, setDomain] = useState('');
  const [touched, setTouched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const clean = cleanDomain(domain);
  const valid = isValidDomain(clean);
  const showError = touched && domain.length > 0 && !valid;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTouched(true);
    if (!valid || loading) return;
    setLoading(true);
    try {
      const params = new URLSearchParams(window.location.search);
      const utm = {
        utm_source: params.get('utm_source') || undefined,
        utm_medium: params.get('utm_medium') || undefined,
        utm_campaign: params.get('utm_campaign') || undefined,
        utm_content: params.get('utm_content') || undefined,
        utm_term: params.get('utm_term') || undefined,
      };
      const res = await fetch('/api/audit/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await staffAuthHeader()) },
        body: JSON.stringify({ url: `https://${clean}`, ...utm }),
      });
      const data = await res.json();
      if (data.auditId) {
        window.location.href = `/audit/${data.auditId}`;
      } else {
        setError(data.error || 'Something went wrong');
        setLoading(false);
      }
    } catch {
      setError('Network error — please try again');
      setLoading(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <form
        className={`${styles.form}${showError ? ' ' + styles.formInvalid : ''}`}
        onSubmit={handleSubmit}
        noValidate
      >
        <label htmlFor="audit-url" className={styles.srOnly}>
          Website domain
        </label>
        <span className={styles.prefix} aria-hidden="true">
          https://
        </span>
        <input
          id="audit-url"
          ref={inputRef}
          type="text"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          placeholder="yourcompany.com"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          onBlur={() => setTouched(true)}
          aria-invalid={showError ? true : undefined}
          aria-describedby={showError ? 'audit-url-error' : undefined}
          className={styles.input}
        />
        <button
          type="submit"
          className={styles.submit}
          disabled={showError}
          aria-label="Audit my site"
        >
          Audit my site <ArrowIcon />
        </button>
      </form>
      {showError && (
        <p id="audit-url-error" role="alert" className={styles.errorMsg}>
          ↑ Enter a valid domain (e.g. example.com)
        </p>
      )}
    </div>
  );
}

export default AuditForm;
