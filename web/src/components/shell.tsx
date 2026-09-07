'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useI18n } from '@/lib/i18n/context';
import { cx } from './ui/primitives';

const NAV = [
  { href: '/', key: 'overview' },
  { href: '/payments', key: 'payments' },
  { href: '/students', key: 'students' },
  { href: '/subscriptions', key: 'subscriptions' },
  { href: '/reconciliation', key: 'reconciliation' },
  { href: '/payouts', key: 'payouts' },
  { href: '/expenses', key: 'expenses' },
  { href: '/import', key: 'import' },
  { href: '/health', key: 'health' },
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
    <nav className="space-y-0.5">
      {NAV.map((item) => {
        const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setOpen(false)}
            aria-current={active ? 'page' : undefined}
            className={cx(
              'block rounded-lg px-3 py-2 text-sm transition-colors',
              active
                ? 'bg-brand-soft font-medium text-brand'
                : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
            )}
          >
            {t.nav[item.key]}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar. `border-e` is direction-aware, so it lands on the
          correct side in both RTL and LTR without a second rule. */}
      <aside className="hidden w-56 shrink-0 border-e border-border bg-surface p-4 lg:block">
        <div className="mb-6 px-3">
          <p className="text-sm font-semibold text-ink">{t.common.appName}</p>
          {email && <p className="mt-0.5 truncate text-xs text-ink-faint" dir="ltr">{email}</p>}
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
          <p className="text-sm font-semibold text-ink">{t.common.appName}</p>
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
