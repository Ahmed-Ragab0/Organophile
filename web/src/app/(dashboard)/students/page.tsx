'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { downloadCsv, formatDate, toCsv } from '@/lib/format';
import {
  Button, Card, CardHeader, Field, Input, PageHeader, Select,
} from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/table';
import { Money, PaymentStatusBadge, StatCard } from '@/components/domain';
import type {
  Course, PaymentStatus, StudentFinancials, University,
} from '@/types/database';

const STATUSES: PaymentStatus[] = ['paid', 'partial', 'unpaid', 'overdue', 'unknown'];
const PAGE_SIZE = 200;

export default function StudentsPage() {
  const { t, locale } = useI18n();

  const [search, setSearch] = useState('');
  const [universityId, setUniversityId] = useState('');
  const [courseId, setCourseId] = useState('');
  const [status, setStatus] = useState('');
  const [active, setActive] = useState('');
  const [registeredFrom, setRegisteredFrom] = useState('');
  const [registeredTo, setRegisteredTo] = useState('');
  const [onlyDebt, setOnlyDebt] = useState(false);
  const [onlyPaid, setOnlyPaid] = useState(false);
  const [page, setPage] = useState(0);

  const universities = useSupabaseQuery<University[]>(
    (sb) => sb.from('universities').select('*').order('name'),
    [],
  );

  // Courses narrow to the chosen university, so the two selects cannot
  // combine into a filter that returns nothing.
  const courses = useSupabaseQuery<Course[]>(
    (sb) => {
      let q = sb.from('courses').select('*').order('name');
      if (universityId) q = q.eq('university_id', universityId);
      return q;
    },
    [universityId],
  );

  const { data, loading, error } = useSupabaseQuery<StudentFinancials[]>(
    (sb) =>
      sb.rpc('search_students', {
        p_search: search || null,
        p_university_id: universityId || null,
        p_course_id: courseId || null,
        p_payment_status: status || null,
        p_active: active === '' ? null : active === 'true',
        p_group_name: null,
        p_registered_from: registeredFrom || null,
        p_registered_to: registeredTo || null,
        p_only_with_debt: onlyDebt,
        p_only_fully_paid: onlyPaid,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
      }),
    [search, universityId, courseId, status, active, registeredFrom, registeredTo, onlyDebt, onlyPaid, page],
  );

  const rows = data ?? [];
  const totals = rows.reduce(
    (acc, r) => ({
      due: acc.due + Number(r.total_due ?? 0),
      paid: acc.paid + Number(r.total_paid ?? 0),
      remaining: acc.remaining + Number(r.remaining ?? 0),
    }),
    { due: 0, paid: 0, remaining: 0 },
  );

  function change<T>(setter: (v: T) => void) {
    return (v: T) => { setPage(0); setter(v); };
  }

  function resetFilters() {
    setPage(0);
    setSearch(''); setUniversityId(''); setCourseId(''); setStatus(''); setActive('');
    setRegisteredFrom(''); setRegisteredTo(''); setOnlyDebt(false); setOnlyPaid(false);
  }

  const columns: Array<Column<StudentFinancials>> = [
    {
      key: 'name',
      header: t.students.name,
      render: (r) => (
        <Link href={`/students/${r.student_id}`} className="min-w-0 block">
          <p className="truncate font-medium text-ink hover:text-accent-strong">{r.name}</p>
          {r.phone && <p className="ltr-id truncate text-ink-faint">{r.phone}</p>}
        </Link>
      ),
    },
    {
      key: 'university',
      header: t.students.university,
      render: (r) => r.university_name ?? <span className="text-ink-faint">—</span>,
    },
    {
      key: 'courses',
      header: t.students.subscriptions,
      render: (r) =>
        r.courses
          ? <span className="text-xs text-ink-muted">{r.courses}</span>
          : <span className="text-ink-faint">—</span>,
    },
    {
      key: 'due', header: t.studentDetail.totalDue, numeric: true,
      render: (r) => <Money value={Number(r.total_due ?? 0)} tone="plain" />,
    },
    {
      key: 'paid', header: t.studentDetail.totalPaid, numeric: true,
      render: (r) => <Money value={Number(r.total_paid ?? 0)} tone="ok" />,
    },
    {
      key: 'remaining', header: t.studentDetail.remaining, numeric: true,
      render: (r) => (
        <Money
          value={Number(r.remaining ?? 0)}
          tone={Number(r.remaining ?? 0) > 0 ? 'danger' : 'plain'}
        />
      ),
    },
    {
      key: 'status', header: t.studentDetail.status,
      render: (r) => <PaymentStatusBadge status={r.payment_status} />,
    },
    {
      key: 'registered', header: t.students.createdAt,
      render: (r) => (
        <span className="text-xs text-ink-muted">{formatDate(r.registered_at, locale)}</span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t.students.title}
        subtitle={t.students.subtitle}
        action={
          <div className="flex gap-2">
            <Button variant="ghost" onClick={resetFilters}>{t.common.reset}</Button>
            <Button
              variant="secondary"
              onClick={() =>
                downloadCsv(
                  `students-${new Date().toISOString().slice(0, 10)}.csv`,
                  toCsv(rows as unknown as Array<Record<string, unknown>>, [
                    'name', 'phone', 'university_name', 'group_name', 'courses',
                    'total_due', 'total_paid', 'remaining', 'payment_status', 'registered_at',
                  ]),
                )}
            >
              {t.common.export}
            </Button>
          </div>
        }
      />

      <section className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard label={t.studentDetail.totalDue} value={<Money value={totals.due} tone="plain" />} />
        <StatCard label={t.studentDetail.totalPaid} value={<Money value={totals.paid} tone="ok" />} />
        <StatCard
          label={t.finance.outstanding}
          value={<Money value={totals.remaining} tone={totals.remaining > 0 ? 'danger' : 'plain'} />}
          emphasis
        />
      </section>

      <Card className="mb-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t.common.search} hint={`${t.students.name} · ${t.students.phone}`}>
            <Input
              value={search}
              placeholder="أحمد / 010…"
              onChange={(e) => change(setSearch)(e.target.value)}
            />
          </Field>

          <Field label={t.courses.university}>
            <Select
              value={universityId}
              onChange={(e) => { change(setUniversityId)(e.target.value); setCourseId(''); }}
            >
              <option value="">{t.courses.allUniversities}</option>
              {(universities.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </Select>
          </Field>

          <Field label={t.courses.course}>
            <Select value={courseId} onChange={(e) => change(setCourseId)(e.target.value)}>
              <option value="">{t.common.all}</option>
              {(courses.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>

          <Field label={t.studentDetail.status}>
            <Select value={status} onChange={(e) => change(setStatus)(e.target.value)}>
              <option value="">{t.common.all}</option>
              {STATUSES.map((s) => <option key={s} value={s}>{t.statuses[s]}</option>)}
            </Select>
          </Field>

          <Field label={t.common.mode}>
            <Select value={active} onChange={(e) => change(setActive)(e.target.value)}>
              <option value="">{t.common.all}</option>
              <option value="true">{t.finance.studentsActive}</option>
              <option value="false">{t.wallets.inactive}</option>
            </Select>
          </Field>

          <Field label={`${t.students.createdAt} — ${t.common.from}`}>
            <Input
              type="date" value={registeredFrom}
              onChange={(e) => change(setRegisteredFrom)(e.target.value)}
            />
          </Field>
          <Field label={`${t.students.createdAt} — ${t.common.to}`}>
            <Input
              type="date" value={registeredTo}
              onChange={(e) => change(setRegisteredTo)(e.target.value)}
            />
          </Field>

          <div className="flex flex-col justify-end gap-2 pb-1">
            <label className="flex items-center gap-2 text-xs text-ink-muted">
              <input
                type="checkbox" checked={onlyDebt}
                onChange={(e) => { setPage(0); setOnlyDebt(e.target.checked); if (e.target.checked) setOnlyPaid(false); }}
                className="accent-[var(--color-accent)]"
              />
              {t.statuses.overdue} / {t.statuses.partial}
            </label>
            <label className="flex items-center gap-2 text-xs text-ink-muted">
              <input
                type="checkbox" checked={onlyPaid}
                onChange={(e) => { setPage(0); setOnlyPaid(e.target.checked); if (e.target.checked) setOnlyDebt(false); }}
                className="accent-[var(--color-accent)]"
              />
              {t.statuses.paid}
            </label>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title={t.students.title}
          hint={`${rows.length} ${t.common.rows}`}
          action={
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                {t.common.prev}
              </Button>
              <span className="text-xs tnum text-ink-muted">{page + 1}</span>
              <Button
                size="sm" variant="secondary"
                disabled={rows.length < PAGE_SIZE}
                onClick={() => setPage((p) => p + 1)}
              >
                {t.common.next}
              </Button>
            </div>
          }
        />
        <DataTable
          columns={columns}
          rows={rows}
          keyOf={(r) => r.student_id}
          loading={loading}
          error={error}
          emptyMessage={t.common.empty}
          loadingMessage={t.common.loading}
          errorMessage={t.common.error}
        />
      </Card>
    </>
  );
}
