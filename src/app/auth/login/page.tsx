'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { createSupabaseBrowser } from '@/lib/supabase/browser';
import styles from '../auth.module.css';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    setError(null);
    setSubmitting(true);

    const { error: signInError } = await createSupabaseBrowser().auth.signInWithPassword({
      email,
      password,
    });

    if (!signInError) {
      router.push('/');
      return;
    }

    setError('Invalid email or password');
    setSubmitting(false);
  }

  return (
    <section className={styles.page}>
      <div className={styles.bg} aria-hidden="true">
        <div className={styles.grid} />
      </div>

      <div className={styles.card}>
        <span className={styles.eyebrow}>
          <span className={styles.eyebrowDot} aria-hidden="true" />
          AEO Auditor
        </span>

        <h1 className={styles.title}>Welcome back</h1>
        <p className={styles.subtitle}>
          Sign in to review your audits and pick up where you left off.
        </p>

        <form className={styles.form} onSubmit={onSubmit} noValidate>
          <div className={styles.field}>
            <label htmlFor="email" className={styles.label}>
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'login-error' : undefined}
              className={styles.input}
              placeholder="you@company.com"
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="password" className={styles.label}>
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'login-error' : undefined}
              className={styles.input}
            />
          </div>

          {error && (
            <p id="login-error" role="alert" className={styles.error}>
              {error}
            </p>
          )}

          <button type="submit" disabled={submitting} className={styles.submit}>
            {submitting ? (
              <>
                <span className={styles.spinner} aria-hidden="true" />
                Signing in…
              </>
            ) : (
              'Sign in'
            )}
          </button>
        </form>
      </div>
    </section>
  );
}
