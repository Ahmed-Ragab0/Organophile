'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n/context';
import { useAccess } from '@/lib/access/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { downloadCsv, formatDate, toCsv } from '@/lib/format';
import {
  Button, Card, CardHeader, Checkbox, Field, Input, PageHeader, Select,
} from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/table';
import {
  LevelBadge, levelName, Money, PaymentStatusBadge, StatCard,
} from '@/components/domain';
import {
  DeleteRecordDialog, EditRecordModal, RecordActions, type FieldSpec,
} from '@/components/record-actions';
import type {
  Course, LevelRow, PaymentStatus, StudentFinancials, Track, University,
} from '@/types/database';

const STATUSES: PaymentStatus[] = ['paid', 'partial', 'unpaid', 'overdue', 'unknown'];
const PAGE_SIZE = 200;

export default function StudentsPage() {
  const { t, locale } = useI18n();
  const { can } = useAccess();
  const mayWrite = can('students.write');
  const router = useRouter();

  const [search, setSearch] = useState('');
  const [universityId, setUniversityId] = useState('');
  const [trackId, setTrackId] = useState('');
  const [level, setLevel] = useState('');
  const [courseId, setCourseId] = useState('');
  const [status, setStatus] = useState('');
  const [active, setActive] = useState('');
  const [registeredFrom, setRegisteredFrom] = useState('');
  const [registeredTo, setRegisteredTo] = useState('');
  const [onlyDebt, setOnlyDebt] = useState(false);
  const [onlyPaid, setOnlyPaid] = useState(false);
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<StudentFinancials | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const universities = useSupabaseQuery<University[]>(
    (sb) => sb.from('universities').select('*').order('name'),
    [],
  );

  const tracks = useSupabaseQuery<Track[]>(
    (sb) => sb.from('tracks').select('*').order('name'),
    [],
  );

  // The options come from the data, not from a hard-coded 1..4: the day this
  // business teaches an Organic 5 the dropdown already knows.
  const levels = useSupabaseQuery<LevelRow[]>(
    (sb) => sb.from('v_levels').select('*'),
    [],
  );
  const levelOptions = (levels.data ?? []).map((l) => l.level);

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

  const { data, loading, error, reload } = useSupabaseQuery<StudentFinancials[]>(
    (sb) =>
      sb.rpc('search_students', {
        p_search: search || null,
        p_university_id: universityId || null,
        p_track_id: trackId || null,
        p_level: level === '' ? null : Number(level),
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
    [search, universityId, trackId, level, courseId, status, active,
     registeredFrom, registeredTo, onlyDebt, onlyPaid, page],
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
    setSearch(''); setUniversityId(''); setTrackId(''); setLevel('');
    setCourseId(''); setStatus(''); setActive('');
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
      key: 'group',
      header: t.students.group,
      /* One cell for the three facts that answer "which group is this
         student in": the level, then the university and specialisation under
         it. Split across three columns they would be scanned three times. */
      render: (r) => (
        <div className="min-w-0">
          {r.level !== null
            ? <LevelBadge level={r.level} />
            : r.course_levels.length > 1
              // Their courses disagree, so no single level is written on them.
              // Showing the ones they are actually enrolled in beats a dash.
              ? (
                <span className="flex flex-wrap items-center gap-1">
                  {r.course_levels.map((l) => <LevelBadge key={l} level={l} tone="neutral" />)}
                </span>
              )
              : <span className="text-ink-faint">{t.students.levelUnknown}</span>}
          <p className="mt-1 truncate text-xs text-ink-faint">
            {[r.university_name, r.track_name].filter(Boolean).join(' · ') || '—'}
          </p>
        </div>
      ),
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
    {
      key: 'actions', header: '',
      render: (r) => (
        <RecordActions
          archived={!r.is_active}
          onView={() => router.push(`/students/${r.student_id}`)}
          onEdit={mayWrite ? () => setEditing(r) : undefined}
          onDelete={mayWrite ? () => setDeleting(r.student_id) : undefined}
        />
      ),
    },
  ];

  /* The editable shape of a student. Money is deliberately absent: what a
     student owes is derived from their subscriptions, and a box here would
     invite someone to disagree with the arithmetic. */
  const studentFields: FieldSpec[] = [
    { name: 'name', label: t.students.name, type: 'text', required: true },
    { name: 'phone', label: t.students.phone, type: 'text' },
    { name: 'email', label: t.students.email, type: 'text' },
    {
      name: 'level', label: t.students.group, type: 'select', numeric: true,
      hint: t.students.groupHint,
      options: levelOptions.map((l) => ({
        value: String(l), label: levelName(l, t.courseInfo.subjectOrganic, locale),
      })),
    },
    // Kept, and finally labelled as what it is. ukkera's export has a free-text
    // "group" column; it is not the level, and calling it المجموعة is what
    // made the two look like one field for as long as they did.
    { name: 'group_name', label: t.students.ukkeraGroup, type: 'text',
      hint: t.students.ukkeraGroupHint },
    {
      name: 'university_id', label: t.students.university, type: 'lookup',
      lookupTable: 'universities', lookupPrompt: t.classification.universityName,
      options: (universities.data ?? []).map((u) => ({ value: u.id, label: u.name })),
      hint: t.students.classifiedHint,
    },
    {
      name: 'track_id', label: t.students.track, type: 'lookup',
      lookupTable: 'tracks', lookupPrompt: t.classification.trackName,
      options: (tracks.data ?? []).map((tr) => ({ value: tr.id, label: tr.name })),
    },
    { name: 'is_active', label: t.students.activeLabel, type: 'checkbox' },
  ];

  return (
    <>
      <PageHeader
        eyebrow={t.navGroups.people}
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
                    'name', 'phone', 'level', 'university_name', 'track_name', 'group_name',
                    'courses',
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

          <Field label={t.students.group} hint={t.students.groupHint}>
            <Select value={level} onChange={(e) => change(setLevel)(e.target.value)}>
              <option value="">{t.common.all}</option>
              {levelOptions.map((l) => (
                <option key={l} value={String(l)}>
                  {levelName(l, t.courseInfo.subjectOrganic, locale)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t.students.track}>
            <Select value={trackId} onChange={(e) => change(setTrackId)(e.target.value)}>
              <option value="">{t.common.all}</option>
              {(tracks.data ?? []).map((tr) => (
                <option key={tr.id} value={tr.id}>{tr.name}</option>
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

          {/* Mutually exclusive by construction: "owes money" and "fully paid"
              cannot both be true, so ticking one clears the other rather than
              silently returning nothing. */}
          <div className="flex flex-col justify-end gap-1 pb-1">
            <Checkbox
              checked={onlyDebt}
              onChange={(next) => {
                setPage(0); setOnlyDebt(next); if (next) setOnlyPaid(false);
              }}
              label={`${t.statuses.overdue} / ${t.statuses.partial}`}
            />
            <Checkbox
              checked={onlyPaid}
              onChange={(next) => {
                setPage(0); setOnlyPaid(next); if (next) setOnlyDebt(false);
              }}
              label={t.statuses.paid}
            />
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

      {editing && (
        <EditRecordModal
          open
          onClose={() => setEditing(null)}
          table="students"
          id={editing.student_id}
          fields={studentFields}
          values={editing as unknown as Record<string, unknown>}
          title={t.records.edit}
          onSaved={reload}
        />
      )}

      <DeleteRecordDialog
        kind="student"
        id={deleting}
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onDone={reload}
      />
    </>
  );
}
