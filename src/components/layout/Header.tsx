'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useStaff } from '@/lib/useStaff';
import styles from './Header.module.css';

export function Header() {
  const pathname = usePathname();
  const isHomepage = pathname === '/';
  const staff = useStaff();

  return (
    <header className={styles.header} role="banner">
      <div className={styles.inner}>
        <Link href="/" className={styles.logo} aria-label="Campaign Creators — AEO Auditor">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://www.campaigncreators.com/hubfs/cc-logo-color-horizontal%20(1).png"
            alt="Campaign Creators"
            height={36}
            className={styles.logoImg}
          />
        </Link>
        {staff && <span className={styles.staffBadge}>Staff</span>}

        {isHomepage && (
          <nav className={styles.nav} aria-label="Main navigation">
            <a className={styles.navLink} href="#how">How it works</a>
            <a className={styles.navLink} href="#engines">AI engines</a>
            <a className={styles.navLink} href="#sample">Sample report</a>
            <a
              className={styles.navLink}
              href="https://www.campaigncreators.com/blog/topic/seo-aeo-geo"
              target="_blank"
              rel="noopener noreferrer"
            >
              Resources
            </a>
          </nav>
        )}

        <div className={styles.ctas}>
          <a
            className={styles.ctaPrimary}
            href="https://www.campaigncreators.com/contact"
            target="_blank"
            rel="noopener noreferrer"
          >
            Let&apos;s Talk
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
              <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
            </svg>
          </a>
        </div>
      </div>
    </header>
  );
}

export default Header;
