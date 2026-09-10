'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n/context';
import { useAccess } from '@/lib/access/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { formatMoney } from '@/lib/format';
import {
  ActiveFilters, Badge, Button, Card, CardHeader, cx, Field, PageHeader, Select,
} from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/table';
import { Money, PaymentStatusBadge, StatCard } from '@/components/domain';
import {
  CreateRecordModal, DeleteRecordDialog, EditRecordModal, RecordActions,
  type FieldSpec, type RecordKind,
} from '@/components/record-actions';
import type { CourseCatalogueRow, StudentFinancials, University } from '@/types/database';

/**
 * The drill-down the brief asks for: كل الجامعات → جامعة → كورس → الطلاب.
 * Each level narrows the one below it, and the money follows the selection so
 * "what is this course worth, and who still owes on it" is one path, not three
 * separate screens.
 */
export default function CoursesPage() {
  const { t, locale } = useI18n();
  const { can } = useAccess();
  const mayWrite = can('courses.write');
  const [universityId, setUniversityId] = useState<string | null>(null);
  const [courseId, setCourseId] = useState<string | null>(null);
  // Track and year come out of the course title, so they can narrow the list
  // the same way the university does — which is the point of parsing them.
  // The track filters on the row's id, not its spelling: two courses written
  // "Clinical" and "CLINICAL" are one specialisation and must filter as one.
  const [trackId, setTrackId] = useState('');
  const [level, setLevel] = useState('');
  const [classYear, setClassYear] = useState('');
  const [creating, setCreating] = useState<RecordKind | null>(null);
  // One pair of dialogs for both levels of the drill-down: a course and a
  // university are the same three verbs over a different kind.
  const [editing, setEditing] = useState<
    { kind: RecordKind; id: string; values: Record<string, unknown> } | null>(null);
  const [deleting, setDeleting] = useState<{ kind: RecordKind; id: string } | null>(null);

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
        p_track_id: trackId || null,
        p_level: level === '' ? null : Number(level),
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
    [universityId, trackId, courseId],
  );

  const allCourses = catalogue.data ?? [];
  const courses = allCourses.filter((c) =>
    (!universityId || c.university_id === universityId)
    && (!trackId || c.track_id === trackId)
    && (!level || String(c.level ?? '') === level)
    && (!classYear || String(c.class_year ?? '') === classYear));

  /** Every value actually present, so a filter never offers an empty result. */
  const tracks = [...new Map(
    allCourses
      .filter((c) => c.track_id)
      .map((c) => [c.track_id as string, c.track_name ?? c.track ?? '—']),
  )].map(([value, label]) => ({ value, label }));
  const years = [...new Set(allCourses.map((c) => c.class_year).filter(Boolean))]
    .sort((a, b) => Number(a) - Number(b)) as number[];
  const levels = [...new Set(allCourses.map((c) => c.level).filter((l) => l !== null))]
    .sort((a, b) => Number(a) - Number(b)) as number[];

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

  /* A course's university, level, section, year and track are all read out of
     its name by a trigger, so the name is the only thing to edit — changing it
     re-derives the rest. Offering separate boxes would let them disagree. */
  const fieldsFor: Record<string, FieldSpec[]> = {
    course: [
      { name: 'name', label: t.courses.course, type: 'text', required: true,
        hint: t.courseInfo.unparsedHint },
      { name: 'is_active', label: t.courses.activeLabel, type: 'checkbox' },
    ],
    university: [
      { name: 'name', label: t.courses.university, type: 'text', required: true },
      { name: 'is_active', label: t.courses.activeLabel, type: 'checkbox' },
    ],
  };

  function afterChange() {
    catalogue.reload();
    universities.reload();
    students.reload();
  }

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
      <PageHeader eyebrow={t.navGroups.people} title={t.courses.title} subtitle={t.courses.subtitle} />

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

      {/* Only shown once there is something to narrow: two filters over three
          courses is furniture, not help. */}
      {(tracks.length > 1 || years.length > 1 || levels.length > 1) && (
        <Card className="mb-4 p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {levels.length > 1 && (
              <Field label={t.students.group}>
                <Select
                  value={level}
                  onChange={(e) => { setLevel(e.target.value); setCourseId(null); }}
                >
                  <option value="">{t.common.all}</option>
                  {levels.map((l) => (
                    <option key={l} value={String(l)}>
                      {`${t.courseInfo.subjectOrganic} ${l}`}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {tracks.length > 1 && (
              <Field label={t.courseInfo.track}>
                <Select
                  value={trackId}
                  onChange={(e) => { setTrackId(e.target.value); setCourseId(null); }}
                >
                  <option value="">{t.common.all}</option>
                  {tracks.map((tr) => (
                    <option key={tr.value} value={tr.value}>{tr.label}</option>
                  ))}
                </Select>
              </Field>
            )}
            {years.length > 1 && (
              <Field label={t.courseInfo.classYear}>
                <Select
                  value={classYear}
                  onChange={(e) => { setClassYear(e.target.value); setCourseId(null); }}
                >
                  <option value="">{t.common.all}</option>
                  {years.map((y) => <option key={y} value={String(y)}>{y}</option>)}
                </Select>
              </Field>
            )}
          </div>
          <div className="mt-3">
            <ActiveFilters
              filters={[
                level && {
                  key: 'level', label: t.students.group,
                  value: `${t.courseInfo.subjectOrganic} ${level}`,
                  onRemove: () => setLevel(''),
                },
                trackId && {
                  key: 'track', label: t.courseInfo.track,
                  value: tracks.find((tr) => tr.value === trackId)?.label ?? trackId,
                  onRemove: () => setTrackId(''),
                },
                classYear && {
                  key: 'year', label: t.courseInfo.classYear, value: classYear,
                  onRemove: () => setClassYear(''),
                },
              ].filter(Boolean) as Array<{
                key: string; label: string; value: string; onRemove: () => void;
              }>}
              onClear={() => { setTrackId(''); setLevel(''); setClassYear(''); }}
              label={t.subscriptions.activeFilters}
              clearAllLabel={t.subscriptions.clearFilters}
            />
          </div>
        </Card>
      )}

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
          <CardHeader
            title={t.courses.university}
            hint={t.classification.subtitle}
            action={
              <div className="flex items-center gap-2">
                {mayWrite && (
                  <Button size="sm" variant="secondary" onClick={() => setCreating('university')}>
                    {t.classification.addUniversity}
                  </Button>
                )}
                <Link
                  href="/classification"
                  className="text-xs text-ink-muted hover:text-accent-strong"
                >
                  {t.classification.title} ←
                </Link>
              </div>
            }
          />
          <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
            {(universities.data ?? []).map((u) => {
              const count = allCourses.filter((c) => c.university_id === u.id).length;
              return (
                <div key={u.id} className="bg-surface p-4">
                  <button
                    type="button"
                    onClick={() => setUniversityId(u.id)}
                    className="block w-full text-start"
                  >
                    <p className="font-medium text-ink hover:text-accent-strong">{u.name}</p>
                    <p className="mt-0.5 text-xs text-ink-faint">
                      {count} {t.courses.course}
                    </p>
                  </button>
                  <div className="mt-3">
                    <RecordActions
                      archived={!u.is_active}
                      onEdit={!mayWrite ? undefined : () => setEditing({
                        kind: 'university', id: u.id,
                        values: u as unknown as Record<string, unknown>,
                      })}
                      onDelete={mayWrite ? () => setDeleting({ kind: 'university', id: u.id }) : undefined}
                    />
                  </div>
                </div>
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
              <div key={c.course_id} className="bg-surface p-4">
              <button
                type="button"
                onClick={() => { setUniversityId(c.university_id); setCourseId(c.course_id); }}
                className="block w-full text-start"
              >
                <p className="truncate font-medium text-ink hover:text-accent-strong">{c.course_name}</p>
                <p className="mt-0.5 text-xs text-ink-faint">{c.university_name}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {c.level !== null && (
                    <Badge tone="brand">{`${t.courseInfo.level} ${c.level}`}</Badge>
                  )}
                  {(c.track_name ?? c.track) && (
                    <Badge tone="info">{c.track_name ?? c.track}</Badge>
                  )}
                  {c.section && (
                    <Badge tone="neutral">
                      {t.courseInfo.sections[c.section as keyof typeof t.courseInfo.sections] ?? c.section}
                    </Badge>
                  )}
                  {c.class_year !== null && (
                    <span className="text-xs text-ink-faint tnum">{c.class_year}</span>
                  )}
                </div>
                <div className="mt-3 flex items-baseline justify-between gap-2 text-xs">
                  <span className="text-ink-muted">
                    {c.enrolled_students} {t.courses.studentsCount}
                  </span>
                  <Money value={Number(c.remaining ?? 0)} tone={Number(c.remaining ?? 0) > 0 ? 'danger' : 'plain'} />
                </div>
              </button>
              <div className="mt-3">
                <RecordActions
                  archived={!c.is_active}
                  onEdit={!mayWrite ? undefined : () => setEditing({
                    kind: 'course', id: c.course_id,
                    values: { name: c.course_name, is_active: c.is_active },
                  })}
                  onDelete={mayWrite ? () => setDeleting({ kind: 'course', id: c.course_id }) : undefined}
                />
              </div>
              </div>
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

      {creating && (
        <CreateRecordModal
          open
          onClose={() => setCreating(null)}
          table="universities"
          values={{ is_active: true }}
          fields={fieldsFor.university}
          title={t.classification.addUniversity}
          onSaved={afterChange}
        />
      )}

      {editing && (
        <EditRecordModal
          open
          onClose={() => setEditing(null)}
          table={editing.kind === 'course' ? 'courses' : 'universities'}
          id={editing.id}
          fields={fieldsFor[editing.kind]}
          values={editing.values}
          title={t.records.edit}
          onSaved={afterChange}
        />
      )}

      <DeleteRecordDialog
        kind={deleting?.kind ?? 'course'}
        id={deleting?.id ?? null}
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onDone={afterChange}
      />
    </>
  );
}
