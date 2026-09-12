'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useI18n } from '@/lib/i18n/context';
import { useMode } from '@/lib/mode/context';
import { useTheme } from '@/lib/theme/context';
import { useAccess } from '@/lib/access/context';
import { permissionForPath } from '@/lib/access/routes';
import { cx } from './ui/primitives';
import {
  IconClose, IconDark, IconLanguage, IconLight, IconLive, IconMenu, IconSignOut,
  IconSystemTheme, IconTest, NAV_ICONS, type NavIconKey,
} from './ui/icons';

/**
 * Grouped so the sidebar reads as three jobs rather than one long list:
 * the money, the people, and the plumbing. The group labels are the point —
 * without them the grouping is a gap, and a gap explains nothing.
 */
const NAV_GROUPS = [
  {
    key: 'money' as const,
    items: [
      { href: '/', key: 'overview' },
      { href: '/wallets', key: 'wallets' },
      { href: '/ledger', key: 'ledger' },
      { href: '/expenses', key: 'expenses' },
      { href: '/approvals', key: 'approvals' },
      { href: '/payroll', key: 'payroll' },
      { href: '/reports', key: 'reports' },
    ],
  },
  {
    /*
     * Its own group, and not folded into "الأكاديمية".
     *
     * For the owner that is a matter of tidiness. For somebody given tasks and
     * nothing else it is the whole sidebar — and a lone "المهام" filed under
     * "الأكاديمية" tells them they are looking at a corner of somebody else's
     * system rather than at their own screen.
     */
    key: 'work' as const,
    items: [
      { href: '/tasks', key: 'tasks' },
    ],
  },
  {
    key: 'people' as const,
    items: [
      { href: '/students', key: 'students' },
      { href: '/courses', key: 'courses' },
      { href: '/subscriptions', key: 'subscriptions' },
      { href: '/pricing', key: 'pricing' },
      { href: '/classification', key: 'classification' },
    ],
  },
  {
    key: 'ops' as const,
    items: [
      { href: '/journey', key: 'journey' },
      { href: '/payments', key: 'payments' },
      { href: '/payouts', key: 'payouts' },
      { href: '/reconciliation', key: 'reconciliation' },
      { href: '/import', key: 'import' },
      { href: '/settings', key: 'settings' },
      { href: '/staff', key: 'staff' },
      { href: '/health', key: 'health' },
    ],
  },
] as const;

/** The mark sits on the brand ramp: the artwork is white, so it needs a ground. */
function BrandMark({ size = 40 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="brand-ramp flex shrink-0 items-center justify-center rounded-tile shadow-card"
      style={{ width: size, height: size }}
    >
      {/* Rendered from a 96px source rather than `size`: at a 40px tile the
          mark is only ~28px on screen, and a mark that small has to be sharp
          on a 2x display or it reads as a blob. */}
      <Image
        src="/logo-mark.png"
        alt=""
        width={96}
        height={96}
        priority
        className="h-[70%] w-[70%] object-contain"
      />
    </span>
  );
}

/**
 * The environment switch.
 *
 * This is the most consequential control in the app, so it is a two-state
 * segmented control that always shows which side you are on, never a toggle
 * whose meaning depends on remembering its current position. Test mode also
 * tints the whole top bar — if you are looking at synthetic data, that fact
 * should be visible without going looking for it.
 */
function ModeSwitch() {
  const { t } = useI18n();
  const { mode, setMode } = useMode();

  const options = [
    { value: 'live' as const, label: t.mode.live, Icon: IconLive, hint: t.mode.liveHint },
    { value: 'test' as const, label: t.mode.test, Icon: IconTest, hint: t.mode.testHint },
  ];

  return (
    <div
      role="radiogroup"
      aria-label={t.mode.label}
      className="flex items-center gap-0.5 rounded-full border border-border bg-surface-2 p-0.5"
    >
      {options.map(({ value, label, Icon, hint }) => {
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setMode(value)}
            title={hint}
            className={cx(
              'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium',
              'transition-[background-color,color,box-shadow] duration-150 ease-soft',
              active && value === 'live' && 'bg-surface text-ok shadow-card',
              active && value === 'test' && 'bg-warn text-white shadow-card',
              !active && 'text-ink-faint hover:text-ink',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Appearance: follow the machine, or pin light or dark.
 *
 * One button that cycles, rather than three side by side — this sits in a bar
 * that already carries a two-option mode switch, and a second segmented
 * control beside it would read as another environment choice. The icon always
 * shows the CURRENT state and the tooltip names what a press will do, so the
 * cycle never has to be memorised.
 */
function ThemeButton() {
  const { t } = useI18n();
  const { theme, cycle } = useTheme();

  const current = {
    system: { Icon: IconSystemTheme, label: t.theme.system },
    light: { Icon: IconLight, label: t.theme.light },
    dark: { Icon: IconDark, label: t.theme.dark },
  }[theme];

  const next = { system: t.theme.light, light: t.theme.dark, dark: t.theme.system }[theme];
  const Icon = current.Icon;

  return (
    <button
      type="button"
      onClick={cycle}
      title={`${t.theme.label}: ${current.label} — ${t.theme.switchTo} ${next}`}
      aria-label={`${t.theme.label}: ${current.label}`}
      className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

export function Shell({ email, children }: { email: string | null; children: React.ReactNode }) {
  const { t, locale, toggleLocale } = useI18n();
  const { isTest } = useMode();
  const { can, role } = useAccess();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  async function signOut() {
    await createClient().auth.signOut();
    /*
     * A full document load, not `router.replace` + `router.refresh`.
     *
     * Who you are is read on the SERVER, once, in the dashboard layout, and
     * handed down through `AccessProvider`. A client-side navigation can
     * re-use that layout from the router cache — so signing out and back in as
     * somebody else leaves the previous account's screen rendered over the new
     * account's session: their buttons, your permissions, and the database
     * refusing one request at a time with "new row violates row-level security
     * policy". Reported exactly that way.
     *
     * This costs one page load at an event that happens twice a day, and it
     * makes that whole class of confusion impossible.
     */
    window.location.replace('/login');
  }

  /*
   * A link to a page the middleware would refuse is worse than no link: it
   * looks like a broken page rather than a boundary. Both read the same map,
   * so the sidebar and the router cannot disagree — and a group that empties
   * out drops its heading with it rather than leaving a label over nothing.
   */
  const groups = NAV_GROUPS
    .map((group) => ({
      key: group.key,
      items: group.items.filter((item) => {
        const needed = permissionForPath(item.href);
        return needed === null || can(needed);
      }),
    }))
    .filter((group) => group.items.length > 0);

  const nav = (
    <nav className="space-y-6">
      {groups.map((group) => (
        <div key={group.key}>
          <p className="mb-1.5 px-3 text-[0.625rem] font-semibold tracking-[0.14em] text-ink-faint uppercase">
            {t.navGroups[group.key]}
          </p>
          <div className="space-y-0.5">
            {group.items.map((item) => {
              const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              const Icon = NAV_ICONS[item.key as NavIconKey];
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  // Closes the mobile drawer on navigation; otherwise the new
                  // page renders behind a menu you have to dismiss by hand.
                  onClick={() => setOpen(false)}
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    'group relative flex items-center gap-2.5 rounded-field py-2 pe-3 ps-2.5 text-sm',
                    'transition-[background-color,color] duration-150 ease-soft',
                    active
                      ? 'bg-accent-soft font-medium text-accent-strong'
                      : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
                  )}
                >
                  {/* The active marker is a filled bar, not a colour change
                      alone, so the current page survives a colour-blind
                      reading — and the icon is a second, redundant cue. */}
                  <span
                    aria-hidden
                    className={cx(
                      'h-5 w-0.5 shrink-0 rounded-full transition-colors duration-150',
                      active ? 'bg-accent' : 'bg-transparent group-hover:bg-border-strong',
                    )}
                  />
                  <Icon
                    className={cx(
                      'h-[18px] w-[18px] shrink-0 transition-colors duration-150',
                      active ? 'text-accent-strong' : 'text-ink-faint group-hover:text-ink-muted',
                    )}
                  />
                  {t.nav[item.key]}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );

  const topbarControls = (
    <>
      <ModeSwitch />
      <button
        type="button"
        onClick={toggleLocale}
        title={t.common.language}
        className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-2 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <IconLanguage className="h-3.5 w-3.5" />
        {t.common.language}
      </button>
      <ThemeButton />
      <button
        type="button"
        onClick={signOut}
        title={t.common.signOut}
        aria-label={t.common.signOut}
        className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface text-ink-muted transition-colors hover:bg-danger-soft hover:text-danger"
      >
        <IconSignOut className="h-4 w-4" />
      </button>
    </>
  );

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar. `border-e` is direction-aware, so it lands on the
          correct side in both RTL and LTR without a second rule. */}
      <aside className="hidden w-64 shrink-0 flex-col border-e border-border bg-surface p-4 lg:flex">
        <Link href="/" className="mb-7 flex items-center gap-3 px-2 py-1">
          <BrandMark />
          <div className="min-w-0">
            <p className="font-display text-sm font-semibold text-ink display-tight">
              {t.common.appName}
            </p>
            <p className="text-[0.6875rem] text-ink-faint">{t.common.appTagline}</p>
          </div>
        </Link>
        <div className="min-h-0 flex-1 overflow-y-auto">{nav}</div>
        {email && (
          <div className="mt-6 flex items-center gap-2.5 rounded-field border border-border bg-surface-2 px-3 py-2.5">
            <span
              aria-hidden
              className="brand-ramp flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
            >
              {email.slice(0, 1).toUpperCase()}
            </span>
            {/* The role sits under the address because "what am I allowed
                to do here" is the question a shared system raises, and the
                answer should not require opening a page to find. */}
            <div className="min-w-0">
              <p className="truncate text-xs text-ink-muted" dir="ltr">{email}</p>
              {role && (
                <p className="truncate text-[0.6875rem] text-ink-faint">
                  {locale === 'en' ? (role.name_en ?? role.name) : role.name}
                </p>
              )}
            </div>
          </div>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className={cx(
            'sticky top-0 z-30 flex items-center justify-between gap-3 border-b px-4 py-2.5 backdrop-blur sm:px-6 lg:px-8',
            // A tinted bar is the ambient reminder that nothing on screen is
            // real money.
            isTest ? 'border-warn/30 bg-warn-soft/85' : 'border-border bg-surface/85',
          )}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls="mobile-nav"
              aria-label={t.common.menu}
              className="flex h-9 w-9 items-center justify-center rounded-field border border-border bg-surface text-ink transition-colors hover:bg-surface-2 lg:hidden"
            >
              {open ? <IconClose className="h-4 w-4" /> : <IconMenu className="h-4 w-4" />}
            </button>
            <Link href="/" className="flex items-center gap-2.5 lg:hidden">
              <BrandMark size={30} />
              <p className="font-display text-sm font-semibold text-ink display-tight">
                {t.common.appName}
              </p>
            </Link>
            {isTest && (
              <p className="hidden text-xs font-medium text-warn sm:block">{t.mode.banner}</p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <div className="hidden items-center gap-2 sm:flex">{topbarControls}</div>
            <div className="flex items-center gap-2 sm:hidden">
              <ModeSwitch />
              <ThemeButton />
            </div>
          </div>
        </header>

        {open && (
          <div id="mobile-nav" className="border-b border-border bg-surface p-4 lg:hidden">
            {nav}
            <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-border pt-4 sm:hidden">
              <button
                type="button"
                onClick={toggleLocale}
                className="flex items-center gap-1.5 rounded-full border border-border px-3 py-2 text-xs font-medium text-ink-muted"
              >
                <IconLanguage className="h-3.5 w-3.5" />
                {t.common.language}
              </button>
              <ThemeButton />
              <button
                type="button"
                onClick={signOut}
                className="flex items-center gap-1.5 rounded-full border border-border px-3 py-2 text-xs font-medium text-ink-muted"
              >
                <IconSignOut className="h-3.5 w-3.5" />
                {t.common.signOut}
              </button>
            </div>
          </div>
        )}

        <main className="mx-auto w-full min-w-0 max-w-[88rem] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
