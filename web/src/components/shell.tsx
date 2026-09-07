'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useI18n } from '@/lib/i18n/context';
import { cx } from './ui/primitives';

/**
 * Grouped so the sidebar reads as three jobs rather than one long list:
 * the money, the people, and the plumbing.
 */
const NAV_GROUPS = [
  {
    key: 'money' as const,
    items: [
      { href: '/', key: 'overview' },
      { href: '/wallets', key: 'wallets' },
      { href: '/ledger', key: 'ledger' },
      { href: '/expenses', key: 'expenses' },
      { href: '/reports', key: 'reports' },
    ],
  },
  {
    key: 'people' as const,
    items: [
      { href: '/students', key: 'students' },
      { href: '/courses', key: 'courses' },
      { href: '/subscriptions', key: 'subscriptions' },
    ],
  },
  {
    key: 'ops' as const,
    items: [
      { href: '/payments', key: 'payments' },
      { href: '/payouts', key: 'payouts' },
      { href: '/reconciliation', key: 'reconciliation' },
      { href: '/import', key: 'import' },
      { href: '/health', key: 'health' },
    ],
  },
] as const;

export function Shell({ email, children }: { email: string | null; children: React.ReactNode }) {
  const { t, toggleLocale } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  async function signOut() {
    await createClient().auth.signOut();
    router.replace('/login');
    router.refresh();
  }

  const nav = (
    <nav className="space-y-4">
      {NAV_GROUPS.map((group) => (
        <div key={group.key} className="space-y-0.5">
          {group.items.map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'flex items-center gap-2 rounded-[--radius-field] px-3 py-2 text-sm transition-colors',
                  active
                    ? 'bg-accent-soft font-medium text-accent-strong'
                    : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
                )}
              >
                {/* The active marker is a filled bar, not a colour change alone,
                    so the current page survives a colour-blind reading. */}
                <span
                  aria-hidden
                  className={cx('h-4 w-0.5 rounded-full', active ? 'bg-accent' : 'bg-transparent')}
                />
                {t.nav[item.key]}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar. `border-e` is direction-aware, so it lands on the
          correct side in both RTL and LTR without a second rule. */}
      <aside className="hidden w-60 shrink-0 border-e border-border bg-surface p-4 lg:block">
        <div className="mb-6 flex items-center gap-2.5 px-3">
          <span aria-hidden className="brand-ramp h-8 w-8 shrink-0 rounded-lg" />
          <div className="min-w-0">
            <p className="font-display text-sm font-semibold text-ink">{t.common.appName}</p>
            {email && <p className="truncate text-xs text-ink-faint" dir="ltr">{email}</p>}
          </div>
        </div>
        {nav}
        <div className="mt-6 space-y-0.5 border-t border-border pt-4">
          <button
            type="button"
            onClick={toggleLocale}
            className="block w-full rounded-lg px-3 py-2 text-start text-sm text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            {t.common.language}
          </button>
          <button
            type="button"
            onClick={signOut}
            className="block w-full rounded-lg px-3 py-2 text-start text-sm text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            {t.common.signOut}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3 lg:hidden">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={t.common.filter}
            className="rounded-lg border border-border px-2.5 py-1.5 text-sm text-ink"
          >
            ☰
          </button>
          <p className="font-display text-sm font-semibold text-ink">{t.common.appName}</p>
          <button
            type="button"
            onClick={toggleLocale}
            className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-ink-muted"
          >
            {t.common.language}
          </button>
        </header>

        {open && (
          <div className="border-b border-border bg-surface p-4 lg:hidden">
            {nav}
            <button
              type="button"
              onClick={signOut}
              className="mt-2 block w-full rounded-lg px-3 py-2 text-start text-sm text-ink-muted hover:bg-surface-2"
            >
              {t.common.signOut}
            </button>
          </div>
        )}

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
