'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { formatNumber } from '@/lib/format';
import { Badge, cx } from '@/components/ui/primitives';
import type {
  ProjectColour, SessionSource, SessionStatus, TaskPriority, TaskStatus,
} from '@/types/database';

/** The vocabulary the three task screens share. */

export function TaskTabs({ maySeeTeam }: { maySeeTeam: boolean }) {
  const { t } = useI18n();
  const pathname = usePathname();

  const tabs = [
    { href: '/tasks', label: t.tasks.tabsBoard },
    ...(maySeeTeam ? [{ href: '/tasks/team', label: t.tasks.tabsTeam }] : []),
    { href: '/tasks/projects', label: t.tasks.tabsProjects },
  ];

  return (
    <nav
      aria-label={t.tasks.title}
      className="mb-4 flex w-fit max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-border bg-surface-2 p-0.5"
    >
      {tabs.map((tab) => {
        const active = tab.href === '/tasks'
          ? pathname === '/tasks'
          : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cx(
              'rounded-full px-4 py-1.5 text-xs font-medium whitespace-nowrap',
              'transition-[background-color,color,box-shadow] duration-150 ease-soft',
              active ? 'bg-surface text-brand shadow-card' : 'text-ink-muted hover:text-ink',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

export const TASK_COLUMNS: TaskStatus[] = ['todo', 'in_progress', 'done'];

export function useStatusLabel(): (s: TaskStatus) => string {
  const { t } = useI18n();
  return (s) => ({
    todo: t.tasks.todo,
    in_progress: t.tasks.inProgress,
    done: t.tasks.done,
    cancelled: t.tasks.cancelled,
  }[s]);
}

export function usePriorityLabel(): (p: TaskPriority) => string {
  const { t } = useI18n();
  return (p) => ({
    low: t.tasks.priorityLow,
    medium: t.tasks.priorityMedium,
    high: t.tasks.priorityHigh,
    urgent: t.tasks.priorityUrgent,
  }[p]);
}

/**
 * Priority is drawn as a rising weight, not four unrelated colours.
 *
 * Low is deliberately almost invisible: on a board of thirty cards, marking
 * the ordinary ones is what stops the urgent ones from standing out.
 */
const PRIORITY_TONE: Record<TaskPriority, 'neutral' | 'info' | 'warn' | 'danger'> = {
  low: 'neutral',
  medium: 'info',
  high: 'warn',
  urgent: 'danger',
};

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  const label = usePriorityLabel();
  if (priority === 'low') {
    return <span className="text-xs text-ink-faint">{label(priority)}</span>;
  }
  return <Badge tone={PRIORITY_TONE[priority]}>{label(priority)}</Badge>;
}

const COLOUR_BAR: Record<ProjectColour, string> = {
  brand: 'bg-brand',
  accent: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
  neutral: 'bg-border-strong',
};

const COLOUR_CHIP: Record<ProjectColour, 'brand' | 'accent' | 'ok' | 'warn' | 'danger' | 'info' | 'neutral'> = {
  brand: 'brand', accent: 'accent', ok: 'ok', warn: 'warn',
  danger: 'danger', info: 'info', neutral: 'neutral',
};

export function ProjectStripe({ colour }: { colour: ProjectColour | null }) {
  return (
    <span
      aria-hidden
      className={cx(
        'absolute inset-y-2 start-0 w-1 rounded-e-full',
        COLOUR_BAR[colour ?? 'neutral'],
      )}
    />
  );
}

export function ProjectChip({
  name, colour,
}: { name: string | null; colour: ProjectColour | null }) {
  if (!name) return null;
  return <Badge tone={COLOUR_CHIP[colour ?? 'neutral']}>{name}</Badge>;
}

export const PROJECT_COLOURS: ProjectColour[] =
  ['brand', 'accent', 'ok', 'warn', 'danger', 'info', 'neutral'];

/**
 * A duration, said the way a person would say it.
 *
 * "2h 35m", not 155 and not 2.58. Minutes alone stop being readable somewhere
 * around ninety, and a decimal hour is a number you have to convert before you
 * can picture it.
 */
export function useDuration(): (minutes: number | null | undefined) => string {
  const { locale } = useI18n();
  return (minutes) => {
    const m = Math.max(0, Math.round(Number(minutes ?? 0)));
    const h = Math.floor(m / 60);
    const rest = m % 60;
    const hh = formatNumber(h, locale);
    const mm = formatNumber(rest, locale);
    if (h === 0) return locale === 'ar' ? `${mm} د` : `${mm}m`;
    if (rest === 0) return locale === 'ar' ? `${hh} س` : `${hh}h`;
    return locale === 'ar' ? `${hh} س ${mm} د` : `${hh}h ${mm}m`;
  };
}

export function Duration({ minutes }: { minutes: number | null | undefined }) {
  const format = useDuration();
  return <span className="tnum whitespace-nowrap">{format(minutes)}</span>;
}

/**
 * A clock that is actually running, counting up from when it started.
 *
 * Ticks in the browser rather than re-fetching: the server already said when
 * this began, and asking it again every second to be told the same thing is a
 * request per second per open tab for a number arithmetic can produce.
 */
export function Elapsed({ since }: { since: string }) {
  const { locale } = useI18n();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const started = new Date(since).getTime();
  const total = Math.max(0, Math.floor((now - started) / 1000));
  const pad = (n: number) => formatNumber(n, locale).padStart(2, '0');
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;

  return (
    <span dir="ltr" className="tnum tabular-nums">
      {h > 0 ? `${pad(h)}:` : ''}{pad(m)}:{pad(sec)}
    </span>
  );
}

export function SourceBadge({ source }: { source: SessionSource }) {
  const { t } = useI18n();
  return source === 'timer'
    ? <Badge tone="neutral">{t.tasks.sourceTimer}</Badge>
    : <Badge tone="info">{t.tasks.sourceManual}</Badge>;
}

export function SessionStatusBadge({ status }: { status: SessionStatus }) {
  const { t } = useI18n();
  const map: Record<SessionStatus, { tone: 'ok' | 'warn' | 'danger' | 'neutral'; label: string }> = {
    tracked: { tone: 'neutral', label: t.tasks.statusTracked },
    approved: { tone: 'ok', label: t.tasks.statusApproved },
    pending: { tone: 'warn', label: t.tasks.statusPending },
    rejected: { tone: 'danger', label: t.tasks.statusRejected },
  };
  const it = map[status];
  return <Badge tone={it.tone}>{it.label}</Badge>;
}

/** Turns a refusal the database named into a sentence in the reader's language. */
export function useTaskReason(): (reason: string | undefined) => string {
  const { t } = useI18n();
  return (reason) => ({
    not_found: t.tasks.reasonNotFound,
    not_an_employee: t.tasks.reasonNotAnEmployee,
    task_closed: t.tasks.reasonTaskClosed,
    nothing_running: t.tasks.reasonNothingRunning,
    overlaps: t.tasks.reasonOverlaps,
    bad_range: t.tasks.reasonBadRange,
    in_the_future: t.tasks.reasonInTheFuture,
    too_long: t.tasks.reasonTooLong,
    not_pending: t.tasks.reasonNotPending,
    bad_status: t.tasks.reasonBadStatus,
    bad_anchor: t.tasks.reasonBadAnchor,
  }[reason ?? ''] ?? t.common.error);
}
