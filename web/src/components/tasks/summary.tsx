'use client';

import { useI18n } from '@/lib/i18n/context';
import { formatNumber } from '@/lib/format';
import { Card, cx } from '@/components/ui/primitives';
import { Duration, useDuration } from './parts';
import type { ProductivityRow } from '@/types/database';

/**
 * The first thing on the board: your own day.
 *
 * This exists for the person whose whole view of this system is one screen —
 * somebody given `tasks.*` and nothing else. For them the board IS the app,
 * and a bare row of columns with no context reads as half a product. Four
 * numbers and their own name is the difference between "a kanban" and "my
 * work".
 *
 * It is shown to everybody, not only to restricted accounts. The owner's own
 * open tasks are as worth seeing as anybody's, and a screen that changes shape
 * depending on your role is a screen nobody can be told how to use.
 */

/** Morning, afternoon or evening — in Cairo, like every other clock here. */
function useGreeting(): string {
  const { t } = useI18n();
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric', hour12: false, timeZone: 'Africa/Cairo',
  }).format(new Date()));

  if (hour < 12) return t.tasks.greetingMorning;
  if (hour < 17) return t.tasks.greetingAfternoon;
  return t.tasks.greetingEvening;
}

function Tile({
  label, value, hint, tone = 'neutral',
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'brand';
}) {
  const accent = {
    neutral: 'text-ink', ok: 'text-ok', warn: 'text-warn',
    danger: 'text-danger', brand: 'text-brand',
  }[tone];

  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-ink-muted">{label}</p>
      <p className={cx('mt-1.5 font-display text-2xl font-semibold tnum display-tight', accent)}>
        {value}
      </p>
      {hint && <div className="mt-1.5 text-xs text-ink-faint">{hint}</div>}
    </Card>
  );
}

export function MyDay({ me, name }: { me: ProductivityRow; name: string | null }) {
  const { t, locale } = useI18n();
  const greeting = useGreeting();
  const duration = useDuration();

  const pct = me.daily_target_minutes > 0
    ? Math.min(100, Math.round((me.minutes_today / me.daily_target_minutes) * 100))
    : 0;

  const today = new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Cairo',
  }).format(new Date());

  return (
    <section className="mb-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-lg font-semibold text-ink display-tight">
          {greeting}
          {name ? `، ${name}` : ''} <span aria-hidden>👋</span>
        </h2>
        <p className="text-xs text-ink-faint">{today}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label={t.tasks.openTasks}
          value={formatNumber(me.open_tasks, locale)}
          hint={me.in_progress > 0
            ? `${formatNumber(me.in_progress, locale)} ${t.tasks.inProgress}`
            : undefined}
        />
        <Tile
          label={t.tasks.overdue}
          value={formatNumber(me.overdue, locale)}
          // Zero overdue is good news and should read as good news, not as a
          // neutral count sitting next to three other neutral counts.
          tone={me.overdue > 0 ? 'danger' : 'ok'}
          hint={me.overdue === 0 ? t.tasks.nothingLate : undefined}
        />
        <Tile
          label={t.tasks.doneWeek}
          value={formatNumber(me.done_week, locale)}
          tone={me.done_week > 0 ? 'ok' : 'neutral'}
        />
        <Tile
          label={t.tasks.todayWorked}
          value={<Duration minutes={me.minutes_today} />}
          tone={pct >= 100 ? 'ok' : 'brand'}
          hint={(
            <>
              <span className="flex items-baseline justify-between gap-2">
                <span>{t.tasks.ofTarget} {duration(me.daily_target_minutes)}</span>
                <span className="tnum">{formatNumber(pct, locale)}%</span>
              </span>
              <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-surface-3">
                <span
                  className={cx('block h-full rounded-full transition-[width] duration-500 ease-soft',
                    pct >= 100 ? 'bg-ok' : 'brand-ramp')}
                  style={{ width: `${pct}%` }}
                />
              </span>
            </>
          )}
        />
      </div>
    </section>
  );
}
