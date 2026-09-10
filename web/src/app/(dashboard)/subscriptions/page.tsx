'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n/context';
import { useAccess } from '@/lib/access/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { downloadCsv, formatDate, formatMoney, toCsv } from '@/lib/format';
import {
  ActiveFilters, Button, Card, CardHeader, Field, Input, PageHeader, Select,
} from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/table';
import { InstallmentPips, PackageKindBadge } from '@/components/domain';
import {
  DeleteRecordDialog, EditRecordModal, RecordActions, type FieldSpec,
} from '@/components/record-actions';
import { Money, Mono, PaymentStatusBadge, StatCard } from '@/components/domain';
import { PriceSourceBadge } from '@/components/pricing';
import { LevelBadge, levelName, NextDueCell } from '@/components/domain';
import type {
  Course, LevelRow, Package, PaymentStatus, PlanKindRow, SubscriptionListRow,
} from '@/types/database';

const STATUSES: PaymentStatus[] = ['paid', 'partial', 'unpaid', 'overdue', 'unknown'];
const PRICE_SOURCES = ['override', 'package', 'order', 'none'] as const;
const PAGE_SIZE = 100;

/**
 * PostgREST's `or=(...)` is a comma-and-parenthesis grammar, so those
 * characters in a search term do not filter — they corrupt the query. `*` is
 * the wildcard and would silently widen the search. Stripping them is safe
 * here because none of them appear in an order id, a name or a phone number.
 */
function sanitize(term: string): string {
  return term.replace(/[,()*"\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

export default function SubscriptionsPage() {
  const { t, locale } = useI18n();
  const { can } = useAccess();
  const mayWrite = can('subscriptions.write');
  const router = useRouter();

  const [search, setSearch] = useState('');
  const [courseId, setCourseId] = useState('');
  const [packageId, setPackageId] = useState('');
  const [status, setStatus] = useState('');
  const [priceSource, setPriceSource] = useState('');
  // What was bought, as opposed to who bought it: the package kind and the
  // course's track are now columns on the view, so they can be filters rather
  // than something you scan the list for.
  const [planKind, setPlanKind] = useState('');
  // The id, not the word: the same specialisation spelled two ways in two
  // course titles is one row, and must filter as one.
  const [trackId, setTrackId] = useState('');
  const [level, setLevel] = useState('');
  const [editing, setEditing] = useState<SubscriptionListRow | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [enrolledFrom, setEnrolledFrom] = useState('');
  const [enrolledTo, setEnrolledTo] = useState('');
  const [page, setPage] = useState(0);

  const courses = useSupabaseQuery<Course[]>(
    (sb) => sb.from('courses').select('*').order('name'),
    [],
  );

  // Packages narrow to the chosen course, so the two selects cannot be
  // combined into a filter that can only ever return nothing.
  const packages = useSupabaseQuery<Package[]>(
    (sb) => {
      let q = sb.from('packages').select('*').order('name');
      if (courseId) q = q.eq('course_id', courseId);
      return q;
    },
    [courseId],
  );

  // The four hard-coded kinds are rows now, and one of them may be something
  // this build has never heard of.
  const planKinds = useSupabaseQuery<PlanKindRow[]>(
    (sb) => sb.from('plan_kinds').select('*').order('sort_order').order('name'),
    [],
  );

  const levels = useSupabaseQuery<LevelRow[]>(
    (sb) => sb.from('v_levels').select('*'),
    [],
  );
  const kindLabel = (code: string | null | undefined) => {
    const row = (planKinds.data ?? []).find((k) => k.code === code);
    if (!row) return code ?? '';
    return locale === 'en' ? (row.name_en ?? row.name) : row.name;
  };

  const { data, loading, error, reload } = useSupabaseQuery<SubscriptionListRow[]>(
    (sb) => {
      let q = sb
        .from('v_subscriptions_list')
        .select('*')
        .order('enrolled_at', { ascending: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

      const term = sanitize(search);
      if (term) {
        // One box across every identifier a person actually remembers. The
        // digits-only branch exists because a phone gets typed as 010… or
        // +2010… or with spaces, and only the normalised column matches all
        // three.
        const like = `*${term}*`;
        const clauses = [
          `order_id.ilike.${like}`,
          `student_name.ilike.${like}`,
          `student_phone.ilike.${like}`,
          `course_name.ilike.${like}`,
          `package_name.ilike.${like}`,
        ];
        const digits = term.replace(/\D/g, '');
        if (digits.length >= 4) {
          clauses.push(`student_phone_normalized.ilike.*${digits}*`);
        }
        q = q.or(clauses.join(','));
      }

      if (courseId) q = q.eq('course_id', courseId);
      if (packageId) q = q.eq('package_id', packageId);
      if (status) q = q.eq('payment_status', status);
      if (priceSource) q = q.eq('price_source', priceSource);
      if (planKind) q = q.eq('plan_kind', planKind);
      if (trackId) q = q.eq('track_id', trackId);
      if (level) q = q.eq('level', Number(level));
      if (enrolledFrom) q = q.gte('enrolled_at', enrolledFrom);
      // The end date is inclusive: `lte` on a timestamp would cut the day off
      // at midnight and quietly drop everything enrolled that day.
      if (enrolledTo) q = q.lt('enrolled_at', `${enrolledTo}T23:59:59.999`);

      return q as unknown as PromiseLike<{
        data: SubscriptionListRow[] | null;
        error: { message: string } | null;
      }>;
    },
    [search, courseId, packageId, status, priceSource, planKind, trackId, level,
     enrolledFrom, enrolledTo, page],
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

  /** Any filter change returns to page 1: page 3 of a new filter is meaningless. */
  function change<T>(setter: (v: T) => void) {
    return (v: T) => { setPage(0); setter(v); };
  }

  function resetFilters() {
    setPage(0);
    setSearch(''); setCourseId(''); setPackageId(''); setStatus('');
    setPriceSource(''); setPlanKind(''); setTrackId(''); setLevel('');
    setEnrolledFrom(''); setEnrolledTo('');
  }

  // Offered from what the courses actually say, so the select can never
  // present a track that would return nothing.
  const tracks = [...new Map(
    (courses.data ?? [])
      .filter((c) => c.track_id)
      .map((c) => [c.track_id as string, c.track ?? '—']),
  )].map(([value, label]) => ({ value, label }));

  const courseName = (courses.data ?? []).find((c) => c.id === courseId)?.name ?? courseId;
  const packageName = (packages.data ?? []).find((p) => p.id === packageId)?.name ?? packageId;

  const chips = [
    search.trim() && {
      key: 'search', label: t.common.search, value: search.trim(),
      onRemove: () => change(setSearch)(''),
    },
    courseId && {
      key: 'course', label: t.courses.course, value: courseName,
      onRemove: () => change(setCourseId)(''),
    },
    packageId && {
      key: 'package', label: t.subscriptions.package, value: packageName,
      onRemove: () => change(setPackageId)(''),
    },
    status && {
      key: 'status', label: t.studentDetail.status,
      value: t.statuses[status as PaymentStatus],
      onRemove: () => change(setStatus)(''),
    },
    priceSource && {
      key: 'priceSource', label: t.pricing.priceSource,
      value: t.pricing[
        (`source${priceSource[0].toUpperCase()}${priceSource.slice(1)}`) as
          'sourceOverride' | 'sourcePackage' | 'sourceOrder' | 'sourceNone'
      ],
      onRemove: () => change(setPriceSource)(''),
    },
    planKind && {
      key: 'planKind', label: t.pricing.packageKind,
      value: kindLabel(planKind),
      onRemove: () => change(setPlanKind)(''),
    },
    trackId && {
      key: 'track', label: t.courseInfo.track,
      value: tracks.find((tr) => tr.value === trackId)?.label ?? trackId,
      onRemove: () => change(setTrackId)(''),
    },
    level && {
      key: 'level', label: t.students.group,
      value: levelName(Number(level), t.courseInfo.subjectOrganic, locale),
      onRemove: () => change(setLevel)(''),
    },
    enrolledFrom && {
      key: 'from', label: t.common.from, value: enrolledFrom,
      onRemove: () => change(setEnrolledFrom)(''),
    },
    enrolledTo && {
      key: 'to', label: t.common.to, value: enrolledTo,
      onRemove: () => change(setEnrolledTo)(''),
    },
  ].filter(Boolean) as Array<{
    key: string; label: string; value: string; onRemove: () => void;
  }>;

  const columns: Array<Column<SubscriptionListRow>> = [
    {
      key: 'order',
      header: t.subscriptions.orderId,
      render: (r) => (
        <Link href={`/pricing/${r.subscription_id}`} className="block min-w-0">
          <Mono value={r.order_id} />
          <p className="truncate text-xs text-ink-muted">
            {r.student_name ?? <span className="text-ink-faint">{t.pricing.noStudent}</span>}
          </p>
        </Link>
      ),
    },
    {
      key: 'course',
      header: t.subscriptions.course,
      render: (r) => (
        <div className="min-w-0">
          <p className="truncate text-ink">{r.course_name ?? '—'}</p>
          {r.package_name && <p className="truncate text-xs text-ink-faint">{r.package_name}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <LevelBadge level={r.level} />
            <PackageKindBadge kind={r.package_kind} label={kindLabel(r.package_kind)} />
            {(r.track_name ?? r.track) && (
              <span className="text-xs text-ink-faint">{r.track_name ?? r.track}</span>
            )}
            {r.class_year !== null && (
              <span className="text-xs text-ink-faint tnum">{r.class_year}</span>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'plan',
      header: t.plans.plan,
      // Only an instalment purchase has a plan, and only the plan knows what is
      // still owed. A full-course purchase shows nothing rather than a zero
      // that would read as "nothing left to pay".
      render: (r) =>
        r.plan_id
          ? (
            <div className="min-w-0 space-y-1">
              <InstallmentPips
                paid={Number(r.installments_paid ?? 0)}
                total={Number(r.plan_installment_count ?? 0)}
              />
              {r.plan_remaining === null
                ? <p className="text-xs text-warn">{t.plans.priceUnknown}</p>
                : (
                  <p className="text-xs text-ink-muted">
                    {t.plans.remaining}: <span className="tnum">
                      {formatMoney(Number(r.plan_remaining), locale)}
                    </span>
                  </p>
                )}
            </div>
          )
          : <span className="text-ink-faint">—</span>,
    },
    {
      key: 'source',
      header: t.pricing.priceSource,
      render: (r) => <PriceSourceBadge source={r.price_source} />,
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
      key: 'nextDue',
      header: t.plans.nextDue,
      numeric: true,
      render: (r) => (
        <NextDueCell
          date={r.next_due_date}
          amount={r.next_due_amount}
          inDays={r.next_due_in_days}
        />
      ),
    },
    {
      key: 'status',
      header: t.studentDetail.status,
      render: (r) => <PaymentStatusBadge status={r.payment_status ?? undefined} />,
    },
    {
      key: 'date',
      header: t.subscriptions.paymentDate,
      render: (r) => (
        <span className="text-xs text-ink-muted">
          {formatDate(r.payment_date ?? r.enrolled_at, locale)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <RecordActions
          onView={() => router.push(`/pricing/${r.subscription_id}`)}
          onEdit={mayWrite ? () => setEditing(r) : undefined}
          onDelete={mayWrite ? () => setDeleting(r.subscription_id) : undefined}
        />
      ),
    },
  ];

  /* Only what a person decides. The amount ukkera charged and the payments
     against it are facts, not fields. */
  const subscriptionFields: FieldSpec[] = [
    { name: 'total_due', label: t.pricing.totalDue, type: 'number', hint: t.pricing.totalDueHint },
    { name: 'due_date', label: t.pricing.dueDate, type: 'date' },
    { name: 'installment_count', label: t.pricing.installmentCount, type: 'number' },
    { name: 'notes', label: t.pricing.notes, type: 'textarea' },
  ];

  return (
    <>
      <PageHeader
        eyebrow={t.navGroups.people}
        title={t.subscriptions.title}
        subtitle={t.subscriptions.subtitle}
        action={
          <>
            <Link
              href="/pricing"
              className="inline-flex items-center rounded-field border border-border bg-surface px-4 py-2.5 text-sm font-medium text-ink shadow-card transition-colors hover:bg-surface-2"
            >
              {t.nav.pricing} →
            </Link>
            <Button
              variant="secondary"
              disabled={rows.length === 0}
              title={rows.length === 0 ? t.reportsUi.exportEmpty : undefined}
              onClick={() =>
                downloadCsv(
                  `subscriptions-${new Date().toISOString().slice(0, 10)}.csv`,
                  toCsv(
                    rows.map((r) => ({
                      order_id: r.order_id,
                      student: r.student_name ?? '',
                      phone: r.student_phone ?? '',
                      course: r.course_name ?? '',
                      package: r.package_name ?? '',
                      price_source: r.price_source,
                      total_due: r.total_due,
                      total_paid: r.total_paid,
                      remaining: r.remaining,
                      payment_status: r.payment_status ?? '',
                      package_kind: r.package_kind ?? '',
                      university: r.university_label ?? '',
                      level: r.level ?? '',
                      section: r.section ?? '',
                      class_year: r.class_year ?? '',
                      track: r.track_name ?? r.track ?? '',
                      plan_installments_paid: r.installments_paid ?? '',
                      plan_installment_count: r.plan_installment_count ?? '',
                      plan_remaining: r.plan_remaining ?? '',
                      next_due_date: r.next_due_date ?? '',
                      next_due_amount: r.next_due_amount ?? '',
                      ukkera_transfer_id: r.ukkera_transfer_id ?? '',
                      installments: r.installment_count,
                      payment_date: r.payment_date ?? '',
                      enrolled_at: r.enrolled_at,
                      source: r.source,
                    })),
                    [
                      'order_id', 'student', 'phone', 'course', 'package', 'package_kind',
                      'university', 'level', 'section', 'class_year', 'track',
                      'price_source', 'total_due', 'total_paid', 'remaining', 'payment_status',
                      'plan_installments_paid', 'plan_installment_count', 'plan_remaining',
                      'next_due_date', 'next_due_amount',
                      'installments', 'payment_date', 'enrolled_at', 'source',
                      'ukkera_transfer_id',
                    ],
                  ),
                )}
            >
              {t.common.export}
            </Button>
          </>
        }
      />

      {/* Totals for the filtered page, so a filter's effect is a number. */}
      <section className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatCard label={t.studentDetail.totalDue} value={formatMoney(totals.due, locale)} />
        <StatCard label={t.studentDetail.totalPaid} value={formatMoney(totals.paid, locale)} tone="ok" />
        <StatCard
          label={t.studentDetail.remaining}
          value={formatMoney(totals.remaining, locale)}
          tone={totals.remaining > 0 ? 'warn' : 'neutral'}
          emphasis
        />
      </section>

      <Card className="mb-4">
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t.common.search} hint={t.subscriptions.searchHint}>
            <Input
              value={search}
              placeholder="YOK-… / أحمد / 010…"
              onChange={(e) => change(setSearch)(e.target.value)}
            />
          </Field>

          <Field label={t.courses.course}>
            <Select
              value={courseId}
              onChange={(e) => { change(setCourseId)(e.target.value); setPackageId(''); }}
            >
              <option value="">{t.common.all}</option>
              {(courses.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>

          <Field label={t.subscriptions.package}>
            <Select value={packageId} onChange={(e) => change(setPackageId)(e.target.value)}>
              <option value="">{t.common.all}</option>
              {(packages.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>

          <Field label={t.pricing.packageKind}>
            <Select value={planKind} onChange={(e) => change(setPlanKind)(e.target.value)}>
              <option value="">{t.common.all}</option>
              {(planKinds.data ?? []).map((k) => (
                <option key={k.code} value={k.code}>
                  {locale === 'en' ? (k.name_en ?? k.name) : k.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t.students.group}>
            <Select value={level} onChange={(e) => change(setLevel)(e.target.value)}>
              <option value="">{t.common.all}</option>
              {(levels.data ?? []).map((l) => (
                <option key={l.level} value={String(l.level)}>
                  {levelName(l.level, t.courseInfo.subjectOrganic, locale)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t.courseInfo.track}>
            <Select value={trackId} onChange={(e) => change(setTrackId)(e.target.value)}>
              <option value="">{t.common.all}</option>
              {tracks.map((tr) => <option key={tr.value} value={tr.value}>{tr.label}</option>)}
            </Select>
          </Field>

          <Field label={t.studentDetail.status}>
            <Select value={status} onChange={(e) => change(setStatus)(e.target.value)}>
              <option value="">{t.common.all}</option>
              {STATUSES.map((s) => <option key={s} value={s}>{t.statuses[s]}</option>)}
            </Select>
          </Field>

          <Field label={t.pricing.priceSource} hint={t.subscriptions.priceSourceHint}>
            <Select value={priceSource} onChange={(e) => change(setPriceSource)(e.target.value)}>
              <option value="">{t.common.all}</option>
              {PRICE_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {t.pricing[
                    (`source${s[0].toUpperCase()}${s.slice(1)}`) as
                      'sourceOverride' | 'sourcePackage' | 'sourceOrder' | 'sourceNone'
                  ]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={`${t.subscriptions.enrolledAt} — ${t.common.from}`}>
            <Input
              type="date" value={enrolledFrom}
              onChange={(e) => change(setEnrolledFrom)(e.target.value)}
            />
          </Field>
          <Field label={`${t.subscriptions.enrolledAt} — ${t.common.to}`}>
            <Input
              type="date" value={enrolledTo}
              onChange={(e) => change(setEnrolledTo)(e.target.value)}
            />
          </Field>
        </div>

        <ActiveFilters
          filters={chips}
          onClear={resetFilters}
          label={t.subscriptions.activeFilters}
          clearAllLabel={t.subscriptions.clearFilters}
        />
      </Card>

      <Card>
        <CardHeader
          title={t.subscriptions.title}
          hint={
            chips.length > 0
              ? `${rows.length} ${t.common.rows} · ${t.subscriptions.filtered}`
              : `${rows.length} ${t.common.rows}`
          }
          action={
            <div className="flex items-center gap-2">
              <Button
                size="sm" variant="secondary"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                {t.common.prev}
              </Button>
              <span className="tnum text-xs text-ink-muted">{page + 1}</span>
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
          keyOf={(r) => r.subscription_id}
          loading={loading}
          error={error}
          emptyMessage={chips.length > 0 ? t.subscriptions.noMatches : t.common.empty}
          loadingMessage={t.common.loading}
          errorMessage={t.common.error}
          emptyAction={
            chips.length > 0
              ? <Button variant="secondary" onClick={resetFilters}>{t.subscriptions.clearFilters}</Button>
              : undefined
          }
        />
      </Card>

      {editing && (
        <EditRecordModal
          open
          onClose={() => setEditing(null)}
          table="subscriptions"
          id={editing.subscription_id}
          fields={subscriptionFields}
          values={{
            // price_override is what the view calls subscriptions.total_due.
            total_due: editing.price_override ?? '',
            due_date: editing.due_date ?? '',
            installment_count: editing.installment_count,
            notes: '',
          }}
          title={t.records.edit}
          onSaved={reload}
        />
      )}

      <DeleteRecordDialog
        kind="subscription"
        id={deleting}
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onDone={reload}
      />
    </>
  );
}
