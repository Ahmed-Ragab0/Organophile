'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { formatMoney } from '@/lib/format';
import {
  Card, CardHeader, cx, PageHeader,
} from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/table';
import { Money, PaymentStatusBadge, StatCard } from '@/components/domain';
import type { CourseCatalogueRow, StudentFinancials, University } from '@/types/database';

/**
 * The drill-down the brief asks for: كل الجامعات → جامعة → كورس → الطلاب.
 * Each level narrows the one below it, and the money follows the selection so
 * "what is this course worth, and who still owes on it" is one path, not three
 * separate screens.
 */
export default function CoursesPage() {
  const { t, locale } = useI18n();
  const [universityId, setUniversityId] = useState<string | null>(null);
  const [courseId, setCourseId] = useState<string | null>(null);

  const universities = useSupabaseQuery<University[]>(
    (sb) => sb.from('universities').select('*').order('name'),
    [],
  );

  const catalogue = useSupabaseQuery<CourseCatalogueRow[]>(
    (sb) => sb.from('v_course_catalogue').select('*').order('course_name'),
    [],
  );

  const students = useSupabaseQuery<StudentFinancials[]>(
    (sb) =>
      sb.rpc('search_students', {
        p_search: null,
        p_university_id: universityId,
        p_course_id: courseId,
        p_payment_status: null,
        p_active: null,
        p_group_name: null,
        p_registered_from: null,
        p_registered_to: null,
        p_only_with_debt: false,
        p_only_fully_paid: false,
        p_limit: 500,
        p_offset: 0,
      }),
    [universityId, courseId],
  );

  const allCourses = catalogue.data ?? [];
  const courses = universityId
    ? allCourses.filter((c) => c.university_id === universityId)
    : allCourses;

  const selectedCourse = courseId ? allCourses.find((c) => c.course_id === courseId) : null;

  const scope = selectedCourse ? [selectedCourse] : courses;
  const totals = scope.reduce(
    (acc, c) => ({
      due: acc.due + Number(c.total_due ?? 0),
      paid: acc.paid + Number(c.total_paid ?? 0),
      remaining: acc.remaining + Number(c.remaining ?? 0),
    }),
    { due: 0, paid: 0, remaining: 0 },
  );

  const studentColumns: Array<Column<StudentFinancials>> = [
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
      key: 'due', header: t.courses.totalDue, numeric: true,
      render: (r) => <Money value={Number(r.total_due ?? 0)} tone="plain" />,
    },
    {
      key: 'paid', header: t.courses.totalPaid, numeric: true,
      render: (r) => <Money value={Number(r.total_paid ?? 0)} tone="ok" />,
    },
    {
      key: 'remaining', header: t.courses.remaining, numeric: true,
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
  ];

  // The breadcrumb doubles as the way back up a level.
  const crumbs = [
    { label: t.courses.allUniversities, onClick: () => { setUniversityId(null); setCourseId(null); } },
    universityId && {
      label: universities.data?.find((u) => u.id === universityId)?.name ?? '—',
      onClick: () => setCourseId(null),
    },
    selectedCourse && { label: selectedCourse.course_name, onClick: () => {} },
  ].filter(Boolean) as Array<{ label: string; onClick: () => void }>;

  return (
    <>
      <PageHeader title={t.courses.title} subtitle={t.courses.subtitle} />

      <nav className="mb-4 flex flex-wrap items-center gap-1.5 text-sm">
        {crumbs.map((c, i) => (
          <span key={`${c.label}-${i}`} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-ink-faint">›</span>}
            <button
              type="button"
              onClick={c.onClick}
              className={cx(
                'rounded px-1.5 py-0.5',
                i === crumbs.length - 1
                  ? 'font-medium text-ink'
                  : 'text-ink-muted hover:text-accent-strong hover:underline',
              )}
            >
              {c.label}
            </button>
          </span>
        ))}
      </nav>

      <section className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard label={t.courses.totalDue} value={formatMoney(totals.due, locale)} />
        <StatCard label={t.courses.totalPaid} value={formatMoney(totals.paid, locale)} tone="ok" />
        <StatCard
          label={t.courses.remaining}
          value={formatMoney(totals.remaining, locale)}
          tone={totals.remaining > 0 ? 'danger' : 'ok'}
          emphasis
        />
      </section>

      {!universityId && (
        <Card className="mb-4">
          <CardHeader title={t.courses.university} />
          <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
            {(universities.data ?? []).map((u) => {
              const count = allCourses.filter((c) => c.university_id === u.id).length;
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => setUniversityId(u.id)}
                  className="bg-surface p-4 text-start hover:bg-surface-2"
                >
                  <p className="font-medium text-ink">{u.name}</p>
                  <p className="mt-0.5 text-xs text-ink-faint">
                    {count} {t.courses.course}
                  </p>
                </button>
              );
            })}
            {(universities.data ?? []).length === 0 && (
              <p className="bg-surface px-5 py-10 text-center text-sm text-ink-faint sm:col-span-2 lg:col-span-3">
                {t.common.empty}
              </p>
            )}
          </div>
        </Card>
      )}

      {!selectedCourse && (
        <Card className="mb-4">
          <CardHeader title={t.courses.course} hint={`${courses.length} ${t.common.rows}`} />
          <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
            {courses.map((c) => (
              <button
                key={c.course_id}
                type="button"
                onClick={() => { setUniversityId(c.university_id); setCourseId(c.course_id); }}
                className="bg-surface p-4 text-start hover:bg-surface-2"
              >
                <p className="truncate font-medium text-ink">{c.course_name}</p>
                <p className="mt-0.5 text-xs text-ink-faint">{c.university_name}</p>
                <div className="mt-3 flex items-baseline justify-between gap-2 text-xs">
                  <span className="text-ink-muted">
                    {c.students_count} {t.courses.studentsCount}
                  </span>
                  <Money value={Number(c.remaining ?? 0)} tone={Number(c.remaining ?? 0) > 0 ? 'danger' : 'plain'} />
                </div>
              </button>
            ))}
            {courses.length === 0 && (
              <p className="bg-surface px-5 py-10 text-center text-sm text-ink-faint sm:col-span-2 lg:col-span-3">
                {t.common.empty}
              </p>
            )}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader
          title={t.students.title}
          hint={`${(students.data ?? []).length} ${t.common.rows}`}
        />
        <DataTable
          columns={studentColumns}
          rows={students.data ?? []}
          keyOf={(r) => r.student_id}
          loading={students.loading}
          error={students.error}
          emptyMessage={t.common.empty}
          loadingMessage={t.common.loading}
          errorMessage={t.common.error}
        />
      </Card>
    </>
  );
}
