'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useAccess } from '@/lib/access/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { createClient } from '@/lib/supabase/client';
import { formatDate, formatDateTime, formatNumber } from '@/lib/format';
import {
  Badge, Button, Card, CardHeader, ErrorState, Notice, PageHeader, PageSkeleton, cx,
} from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/table';
import { StatCard } from '@/components/domain';
import {
  Duration, Elapsed, SessionStatusBadge, SourceBadge, TaskTabs, useDuration, useTaskReason,
} from '@/components/tasks/parts';
import type { ProductivityRow, TaskResult, TaskSessionRow } from '@/types/database';

/**
 * What the team is carrying, and what it has done.
 *
 * The two halves are deliberately different kinds of thing. The table is a
 * standing picture — open work, hours, what finished this week. The list below
 * it is a queue: time somebody typed in that nobody has agreed to yet, which
 * is the only thing on this page that needs a decision today.
 */
export default function TeamPage() {
  const { t, locale } = useI18n();
  const { can } = useAccess();
  const mayReview = can('team.write');
  const reasonText = useTaskReason();
  const duration = useDuration();

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const people = useSupabaseQuery<ProductivityRow[]>(
    (sb) => sb.from('v_team_productivity').select('*')
      .order('is_active', { ascending: false }).order('full_name'),
    [],
  );
  const pending = useSupabaseQuery<TaskSessionRow[]>(
    (sb) => sb.from('v_task_sessions').select('*')
      .eq('status', 'pending').order('started_at', { ascending: false }),
    [],
  );

  async function review(session: TaskSessionRow, approve: boolean) {
    setBusy(session.id);
    setError(null);
    const { data, error: err } = await createClient().rpc('review_time_entry', {
      p_session_id: session.id, p_approve: approve, p_note: null,
    });
    setBusy(null);
    if (err) { setError(err.message); return; }
    const result = data as TaskResult | null;
    if (!result?.ok) { setError(reasonText(result?.reason)); return; }
    pending.reload();
    people.reload();
  }

  const rows = (people.data ?? []).filter((p) => p.is_active);
  const pendingRows = pending.data ?? [];

  const totals = rows.reduce(
    (acc, r) => ({
      open: acc.open + r.open_tasks,
      overdue: acc.overdue + r.overdue,
      week: acc.week + r.minutes_week,
      done: acc.done + r.done_week,
    }),
    { open: 0, overdue: 0, week: 0, done: 0 },
  );

  const columns: Array<Column<ProductivityRow>> = [
    {
      key: 'person',
      header: t.tasks.person,
      render: (r) => (
        <span className="min-w-0">
          <span className="block truncate font-medium text-ink">{r.full_name}</span>
          {r.job_title && (
            <span className="mt-0.5 block truncate text-xs text-ink-faint">{r.job_title}</span>
          )}
        </span>
      ),
    },
    {
      key: 'now',
      header: t.tasks.running,
      render: (r) => (r.running_since && r.running_task_title ? (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ok">
            <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" />
            <Elapsed since={r.running_since} />
          </span>
          <span className="max-w-44 truncate text-xs text-ink-faint">{r.running_task_title}</span>
        </span>
      ) : (
        <span className="text-xs text-ink-faint">—</span>
      )),
    },
    {
      key: 'today',
      header: t.tasks.todayWorked,
      numeric: true,
      /* The bar is the point: "3h 20m" says nothing until you know whose day
         it is a fraction of, and that number is per person. */
      render: (r) => {
        const pct = r.daily_target_minutes > 0
          ? Math.min(100, Math.round((r.minutes_today / r.daily_target_minutes) * 100))
          : 0;
        return (
          <span className="inline-flex min-w-28 flex-col items-end gap-1">
            <span className="text-xs text-ink">
              <Duration minutes={r.minutes_today} />
              <span className="text-ink-faint"> / {duration(r.daily_target_minutes)}</span>
            </span>
            <span className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
              <span
                className={cx('block h-full rounded-full', pct >= 100 ? 'bg-ok' : 'brand-ramp')}
                style={{ width: `${pct}%` }}
              />
            </span>
          </span>
        );
      },
    },
    {
      key: 'week',
      header: t.tasks.weekWorked,
      numeric: true,
      render: (r) => <Duration minutes={r.minutes_week} />,
    },
    {
      key: 'open',
      header: t.tasks.openTasks,
      numeric: true,
      render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <span className="tnum text-ink">{formatNumber(r.open_tasks, locale)}</span>
          {r.overdue > 0 && (
            <Badge tone="danger">{formatNumber(r.overdue, locale)} {t.tasks.overdue}</Badge>
          )}
        </span>
      ),
    },
    {
      key: 'done',
      header: t.tasks.doneWeek,
      numeric: true,
      render: (r) => <span className="tnum text-ink">{formatNumber(r.done_week, locale)}</span>,
    },
    {
      key: 'seen',
      header: t.tasks.lastSeen,
      render: (r) => (r.last_activity_at
        ? <span className="text-xs whitespace-nowrap text-ink-muted">
          {formatDate(r.last_activity_at, locale)}
        </span>
        : <span className="text-xs text-ink-faint">{t.tasks.noActivity}</span>),
    },
  ];

  if (people.loading && rows.length === 0) return <PageSkeleton label={t.tasks.team} />;
  if (people.error) return <ErrorState message={t.common.error} detail={people.error} />;

  return (
    <>
      <PageHeader
        eyebrow={t.navGroups.work}
        title={t.tasks.title}
        subtitle={t.tasks.subtitle}
      />
      <TaskTabs maySeeTeam />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={t.tasks.openTasks} value={formatNumber(totals.open, locale)} />
        <StatCard
          label={t.tasks.overdue}
          value={formatNumber(totals.overdue, locale)}
          tone={totals.overdue > 0 ? 'danger' : 'ok'}
        />
        <StatCard label={t.tasks.weekWorked} value={duration(totals.week)} emphasis />
        <StatCard label={t.tasks.doneWeek} value={formatNumber(totals.done, locale)} tone="ok" />
      </div>

      {error && <div className="mb-3"><Notice tone="danger">{error}</Notice></div>}

      <Card>
        <CardHeader title={t.tasks.team} hint={t.tasks.teamHint} />
        <DataTable
          rows={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={people.loading}
          error={people.error}
          emptyMessage={t.payroll.noPeople}
          loadingMessage={t.common.loading}
          errorMessage={t.common.error}
        />
      </Card>

      <div className="mt-4">
        <Card>
          <CardHeader
            title={t.tasks.reviews}
            hint={t.tasks.reviewHint}
            action={pendingRows.length > 0
              ? <Badge tone="warn">{formatNumber(pendingRows.length, locale)}</Badge>
              : undefined}
          />
          {pendingRows.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-ink-faint">{t.tasks.noReviews}</p>
          ) : (
            <ul className="divide-y divide-border">
              {pendingRows.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{s.task_title}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-faint">
                      <span>{s.employee_name ?? '—'}</span>
                      <span>·</span>
                      <span>{formatDateTime(s.started_at, locale)}</span>
                      {s.ended_at && <><span>→</span><span>{formatDateTime(s.ended_at, locale)}</span></>}
                    </p>
                    {s.note && <p className="mt-0.5 truncate text-xs text-ink-muted">{s.note}</p>}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <SourceBadge source={s.source} />
                    <SessionStatusBadge status={s.status} />
                    <span className="text-sm font-medium text-ink"><Duration minutes={s.minutes} /></span>
                    {mayReview && (
                      <>
                        <Button
                          size="sm"
                          onClick={() => void review(s, true)}
                          disabled={busy === s.id}
                        >
                          {t.tasks.approve}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void review(s, false)}
                          disabled={busy === s.id}
                        >
                          {t.tasks.reject}
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
