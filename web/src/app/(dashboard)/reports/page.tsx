'use client';

import { useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { downloadCsv, formatMoney, formatNumber, toCsv } from '@/lib/format';
import {
  Badge, Button, Card, CardHeader, cx, EmptyState, Field, PageHeader, PageSkeleton,
  Select, Spinner,
} from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/table';
import { Money, StatCard, WalletStrip } from '@/components/domain';
import { MoneyModeNotice } from '@/components/money-mode-notice';
import { MoneyPositionPanel } from '@/components/money-position';
import type {
  ExpenseByCategory, FeesMonthly, MoneyPosition, MonthlyReport, PayoutsMonthly,
  RevenueByCourse, RevenueByMethod, RevenueByUniversity, StudentFinancials, WalletBalance,
} from '@/types/database';

/**
 * Reports.
 *
 * Two kinds of question live here and they are deliberately kept apart:
 *
 *   PERIOD  — "what happened between these two months": revenue, expenses,
 *             fees, and every breakdown of them.
 *   BALANCE — "where is my money right now": the Kashier position. It has no
 *             period, and pretending it does is how a monthly report gets read
 *             as a cash position.
 *
 * The range is a MONTH range rather than free dates because every underlying
 * view is keyed by month. A day picker over month-granularity data would be a
 * lie at the edges.
 */

type ReportKey =
  | 'months' | 'daily' | 'courses' | 'universities'
  | 'expenses' | 'methods' | 'fees' | 'students' | 'payouts';

type PresetKey = 'this' | 'last' | 'quarter' | 'year' | 'all';

/** ISO month key, e.g. 2026-09-01, in Cairo. */
function monthKey(d: Date): string {
  const cairo = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', timeZone: 'Africa/Cairo',
  }).format(d);
  return `${cairo}-01`;
}

function shiftMonths(iso: string, by: number): string {
  const [y, m] = iso.split('-').map(Number);
  return monthKey(new Date(Date.UTC(y, m - 1 + by, 15)));
}

export default function ReportsPage() {
  const { t, locale } = useI18n();

  const thisMonth = useMemo(() => monthKey(new Date()), []);
  const [from, setFrom] = useState(() => shiftMonths(monthKey(new Date()), -11));
  const [to, setTo] = useState(thisMonth);
  const [report, setReport] = useState<ReportKey>('months');

  const monthLabel = (iso: string) =>
    new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
      month: 'long', year: 'numeric', timeZone: 'UTC',
    }).format(new Date(iso));

  const dayLabel = (iso: string) =>
    new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    }).format(new Date(iso));

  // Every period view is filtered the same way, in the database rather than
  // client-side, so a long history does not have to travel to the browser.
  const useRangeQuery = <T,>(table: string, order: string) =>
    useSupabaseQuery<T[]>(
      (sb) =>
        sb.from(table).select('*').gte('month', from).lte('month', to).order(order),
      [from, to],
    );

  const months = useRangeQuery<MonthlyReport>('v_monthly_report', 'month');
  const byCourse = useRangeQuery<RevenueByCourse>('v_revenue_by_course', 'month');
  const byUniversity = useRangeQuery<RevenueByUniversity>('v_revenue_by_university', 'month');
  const byCategory = useRangeQuery<ExpenseByCategory>('v_expenses_by_category', 'month');
  const byMethod = useRangeQuery<RevenueByMethod>('v_revenue_by_method', 'month');
  const fees = useRangeQuery<FeesMonthly>('v_fees_monthly', 'month');
  const payouts = useRangeQuery<PayoutsMonthly>('v_payouts_monthly', 'month');

  const daily = useSupabaseQuery<Array<{ day: string; revenue: number; expenses: number; net_profit: number }>>(
    (sb) =>
      sb.from('v_finance_daily').select('*')
        .gte('day', from)
        // The last day of the closing month, via day 0 of the next one.
        .lte('day', new Date(Date.UTC(
          Number(to.slice(0, 4)), Number(to.slice(5, 7)), 0,
        )).toISOString().slice(0, 10))
        .order('day', { ascending: false }),
    [from, to],
  );

  const students = useSupabaseQuery<StudentFinancials[]>(
    (sb) => sb.from('v_student_financials').select('*').order('remaining', { ascending: false }),
    [],
  );

  const wallets = useSupabaseQuery<WalletBalance[]>(
    (sb) => sb.from('v_wallet_balances').select('*').order('sort_order'),
    [],
  );

  // Deliberately not range-filtered: a balance has no period.
  const position = useSupabaseQuery<MoneyPosition>(
    (sb) => sb.from('v_money_position').select('*').eq('mode', 'live').single(),
    [],
  );

  const monthRows = months.data ?? [];
  const n = (v: number | null | undefined) => Number(v ?? 0);

  const totals = monthRows.reduce(
    (a, m) => ({
      revenue: a.revenue + n(m.revenue),
      expenses: a.expenses + n(m.expenses),
      net: a.net + n(m.net_profit),
      payments: a.payments + n(m.payments_count),
    }),
    { revenue: 0, expenses: 0, net: 0, payments: 0 },
  );

  const feesTotal = (fees.data ?? []).reduce((a, f) => a + n(f.fees), 0);
  const outstanding = (students.data ?? []).reduce((a, s) => a + n(s.remaining), 0);

  /** Aggregate a month-keyed breakdown down to one row per label. */
  // The index signature on the return type is what lets a caller reach for
  // `.revenue` or `.total` on the collapsed row; a plain spread loses it.
  function collapse<T>(
    rows: T[],
    labelOf: (r: T) => string,
    valuesOf: (r: T) => Record<string, number>,
  ): Array<{ label: string; values: Record<string, number> }> {
    const map = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const key = labelOf(r);
      const prev = map.get(key) ?? {};
      const next = valuesOf(r);
      for (const k of Object.keys(next)) prev[k] = (prev[k] ?? 0) + next[k];
      map.set(key, prev);
    }
    return [...map.entries()].map(([label, values]) => ({ label, values }));
  }

  /** Flattens a collapsed row for the table and the CSV, which want one object. */
  const flat = (rows: Array<{ label: string; values: Record<string, number> }>, sortBy: string) =>
    [...rows]
      .sort((a, b) => (b.values[sortBy] ?? 0) - (a.values[sortBy] ?? 0))
      .map((r) => ({ label: r.label, ...r.values })) as unknown as Row[];

  // ── the report definitions ───────────────────────────────────────────────
  type Row = Record<string, unknown>;

  const REPORTS: Record<ReportKey, {
    label: string;
    loading: boolean;
    error: string | null;
    rows: Row[];
    columns: Array<Column<Row>>;
    csv: string[];
  }> = {
    months: {
      label: t.reportsUi.tabMonths,
      loading: months.loading, error: months.error,
      rows: [...monthRows].reverse() as unknown as Row[],
      csv: ['month', 'revenue', 'expenses', 'net_profit', 'payments_count'],
      columns: [
        { key: 'month', header: t.reportsUi.month, render: (r) => monthLabel(String(r.month)) },
        { key: 'revenue', header: t.reportsUi.revenue, numeric: true, render: (r) => <Money value={n(r.revenue as number)} tone="ok" /> },
        { key: 'expenses', header: t.reportsUi.expenses, numeric: true, render: (r) => <Money value={n(r.expenses as number)} tone="danger" /> },
        { key: 'net', header: t.reportsUi.net, numeric: true, render: (r) => <Money value={n(r.net_profit as number)} tone={n(r.net_profit as number) < 0 ? 'danger' : 'plain'} /> },
        { key: 'count', header: t.reportsUi.count, numeric: true, render: (r) => formatNumber(n(r.payments_count as number), locale) },
      ],
    },
    daily: {
      label: t.reportsUi.tabDaily,
      loading: daily.loading, error: daily.error,
      rows: (daily.data ?? []) as unknown as Row[],
      csv: ['day', 'revenue', 'expenses', 'net_profit'],
      columns: [
        { key: 'day', header: t.reportsUi.day, render: (r) => dayLabel(String(r.day)) },
        { key: 'revenue', header: t.reportsUi.revenue, numeric: true, render: (r) => <Money value={n(r.revenue as number)} tone="ok" /> },
        { key: 'expenses', header: t.reportsUi.expenses, numeric: true, render: (r) => <Money value={n(r.expenses as number)} tone="danger" /> },
        { key: 'net', header: t.reportsUi.net, numeric: true, render: (r) => <Money value={n(r.net_profit as number)} tone={n(r.net_profit as number) < 0 ? 'danger' : 'plain'} /> },
      ],
    },
    courses: {
      label: t.reportsUi.tabCourses,
      loading: byCourse.loading, error: byCourse.error,
      rows: flat(collapse(byCourse.data ?? [], (r) => r.course_name,
        (r) => ({ revenue: n(r.revenue), payments: n(r.payments) })), 'revenue'),
      csv: ['label', 'revenue', 'payments'],
      columns: [
        { key: 'label', header: t.reportsUi.course, render: (r) => String(r.label) },
        { key: 'revenue', header: t.reportsUi.revenue, numeric: true, render: (r) => <Money value={n(r.revenue as number)} tone="ok" /> },
        { key: 'payments', header: t.reportsUi.count, numeric: true, render: (r) => formatNumber(n(r.payments as number), locale) },
      ],
    },
    universities: {
      label: t.reportsUi.tabUniversities,
      loading: byUniversity.loading, error: byUniversity.error,
      rows: flat(collapse(byUniversity.data ?? [], (r) => r.university_name,
        (r) => ({ revenue: n(r.revenue), payments: n(r.payments) })), 'revenue'),
      csv: ['label', 'revenue', 'payments'],
      columns: [
        { key: 'label', header: t.reportsUi.university, render: (r) => String(r.label) },
        { key: 'revenue', header: t.reportsUi.revenue, numeric: true, render: (r) => <Money value={n(r.revenue as number)} tone="ok" /> },
        { key: 'payments', header: t.reportsUi.count, numeric: true, render: (r) => formatNumber(n(r.payments as number), locale) },
      ],
    },
    expenses: {
      label: t.reportsUi.tabExpenses,
      loading: byCategory.loading, error: byCategory.error,
      rows: flat(collapse(byCategory.data ?? [], (r) => r.category,
        (r) => ({ total: n(r.total), entries: n(r.entries) })), 'total'),
      csv: ['label', 'total', 'entries'],
      columns: [
        { key: 'label', header: t.reportsUi.category, render: (r) => String(r.label) },
        { key: 'total', header: t.reportsUi.expenses, numeric: true, render: (r) => <Money value={n(r.total as number)} tone="danger" /> },
        { key: 'entries', header: t.reportsUi.count, numeric: true, render: (r) => formatNumber(n(r.entries as number), locale) },
      ],
    },
    methods: {
      label: t.reportsUi.tabMethods,
      loading: byMethod.loading, error: byMethod.error,
      rows: flat(collapse(byMethod.data ?? [], (r) => r.method,
        (r) => ({ revenue: n(r.revenue), fees: n(r.fees), settled: n(r.settled), payments: n(r.payments) })), 'revenue'),
      csv: ['label', 'revenue', 'fees', 'settled', 'payments'],
      columns: [
        { key: 'label', header: t.reportsUi.method, render: (r) => <Badge tone="info">{String(r.label)}</Badge> },
        { key: 'revenue', header: t.reportsUi.revenue, numeric: true, render: (r) => <Money value={n(r.revenue as number)} tone="ok" /> },
        { key: 'fees', header: t.reportsUi.fees, numeric: true, render: (r) => <Money value={n(r.fees as number)} tone="danger" /> },
        { key: 'settled', header: t.reportsUi.settled, numeric: true, render: (r) => <Money value={n(r.settled as number)} tone="plain" /> },
        { key: 'payments', header: t.reportsUi.count, numeric: true, render: (r) => formatNumber(n(r.payments as number), locale) },
      ],
    },
    fees: {
      label: t.reportsUi.tabFees,
      loading: fees.loading, error: fees.error,
      rows: [...(fees.data ?? [])].reverse() as unknown as Row[],
      csv: ['month', 'gross', 'fees', 'vat', 'fee_rate_pct', 'payments'],
      columns: [
        { key: 'month', header: t.reportsUi.month, render: (r) => monthLabel(String(r.month)) },
        { key: 'gross', header: t.reportsUi.revenue, numeric: true, render: (r) => <Money value={n(r.gross as number)} tone="plain" /> },
        { key: 'fees', header: t.reportsUi.fees, numeric: true, render: (r) => <Money value={n(r.fees as number)} tone="danger" /> },
        { key: 'vat', header: t.reportsUi.vat, numeric: true, render: (r) => <Money value={n(r.vat as number)} tone="plain" /> },
        { key: 'rate', header: t.reportsUi.feeRate, numeric: true, render: (r) => <span className="tnum">{n(r.fee_rate_pct as number).toFixed(2)}%</span> },
        { key: 'payments', header: t.reportsUi.count, numeric: true, render: (r) => formatNumber(n(r.payments as number), locale) },
      ],
    },
    students: {
      label: t.reportsUi.tabStudents,
      loading: students.loading, error: students.error,
      rows: (students.data ?? []) as unknown as Row[],
      csv: ['name', 'phone', 'university_name', 'total_due', 'total_paid', 'remaining', 'payment_status'],
      columns: [
        {
          key: 'name', header: t.reportsUi.student,
          render: (r) => (
            <div className="min-w-0">
              <p className="truncate text-ink">{String(r.name)}</p>
              {r.university_name ? <p className="truncate text-xs text-ink-faint">{String(r.university_name)}</p> : null}
            </div>
          ),
        },
        { key: 'due', header: t.reportsUi.due, numeric: true, render: (r) => <Money value={n(r.total_due as number)} tone="plain" /> },
        { key: 'paid', header: t.reportsUi.paid, numeric: true, render: (r) => <Money value={n(r.total_paid as number)} tone="ok" /> },
        { key: 'remaining', header: t.reportsUi.remaining, numeric: true, render: (r) => <Money value={n(r.remaining as number)} tone={n(r.remaining as number) > 0 ? 'danger' : 'plain'} /> },
      ],
    },
    payouts: {
      label: t.reportsUi.tabPayouts,
      loading: payouts.loading, error: payouts.error,
      rows: [...(payouts.data ?? [])].filter((p) => p.mode === 'live').reverse() as unknown as Row[],
      csv: ['month', 'transfers', 'transferred', 'in_flight', 'failed'],
      columns: [
        { key: 'month', header: t.reportsUi.month, render: (r) => monthLabel(String(r.month)) },
        { key: 'transfers', header: t.reportsUi.transfers, numeric: true, render: (r) => formatNumber(n(r.transfers as number), locale) },
        { key: 'transferred', header: t.reportsUi.transferred, numeric: true, render: (r) => <Money value={n(r.transferred as number)} tone="ok" /> },
        { key: 'inflight', header: t.reportsUi.inFlight, numeric: true, render: (r) => <Money value={n(r.in_flight as number)} tone="plain" /> },
        { key: 'failed', header: t.reportsUi.failed, numeric: true, render: (r) => <Money value={n(r.failed as number)} tone={n(r.failed as number) > 0 ? 'danger' : 'plain'} /> },
      ],
    },
  };

  const active = REPORTS[report];

  /** Rows the export would actually write, for the label under the button. */
  const exportable = active.rows.length;

  // Month options run from the earliest month that has data to this month, so
  // the picker can never select a range that cannot contain anything.
  const monthOptions = useMemo(() => {
    const out: string[] = [];
    let cursor = shiftMonths(thisMonth, -35);
    while (cursor <= thisMonth) {
      out.push(cursor);
      cursor = shiftMonths(cursor, 1);
    }
    return out.reverse();
  }, [thisMonth]);

  /**
   * The month range each preset stands for. Declared once so the buttons can
   * both SET the range and recognise it: a preset that highlights itself when
   * the range already matches is the difference between a filter you can read
   * and five buttons that give no clue which one you pressed.
   */
  const presetRanges: Record<PresetKey, [string, string]> = {
    this: [thisMonth, thisMonth],
    last: [shiftMonths(thisMonth, -1), shiftMonths(thisMonth, -1)],
    quarter: [shiftMonths(thisMonth, -2), thisMonth],
    year: [shiftMonths(thisMonth, -11), thisMonth],
    all: [monthOptions[monthOptions.length - 1], thisMonth],
  };

  const activePreset = (Object.keys(presetRanges) as PresetKey[]).find(
    (k) => presetRanges[k][0] === from && presetRanges[k][1] === to,
  ) ?? null;

  /** How many months the range covers, inclusive. */
  const monthSpan = useMemo(() => {
    const [fy, fm] = from.split('-').map(Number);
    const [ty, tm] = to.split('-').map(Number);
    return Math.max(0, (ty - fy) * 12 + (tm - fm) + 1);
  }, [from, to]);

  function preset(kind: PresetKey) {
    const [f, tt] = presetRanges[kind];
    setFrom(f);
    setTo(tt);
  }

  if (months.loading && monthRows.length === 0) {
    return <PageSkeleton label={t.common.loading} />;
  }

  return (
    <>
      <PageHeader
        eyebrow={t.navGroups.money}
        title={t.reports.title}
        subtitle={t.reports.subtitle}
        action={
          /*
            A disabled button with no reason reads as broken. Export is
            disabled only because the selected report has no rows in the
            selected range — so the button says which, and how many rows it
            would write when there are some.
          */
          <div className="flex flex-col items-stretch gap-1">
            <Button
              variant="secondary"
              disabled={exportable === 0}
              title={exportable === 0 ? t.reportsUi.exportEmpty : undefined}
              onClick={() =>
                downloadCsv(
                  `${report}-${from}_${to}.csv`,
                  toCsv(active.rows as Array<Record<string, unknown>>, active.csv),
                )}
            >
              {t.reportsUi.exportThis}
            </Button>
            <span className="text-center text-[0.6875rem] text-ink-faint">
              {active.loading
                ? t.common.loading
                : exportable === 0
                  ? t.reportsUi.exportEmpty
                  : `${formatNumber(exportable, locale)} ${t.common.rows} · CSV`}
            </span>
          </div>
        }
      />

      <MoneyModeNotice />

      {/* ── the period filter ────────────────────────────────────────── */}
      <Card className="mb-5 p-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)]">
          <Field label={t.reportsUi.fromMonth}>
            <Select value={from} onChange={(e) => setFrom(e.target.value)}>
              {monthOptions.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </Select>
          </Field>
          <Field label={t.reportsUi.toMonth}>
            <Select value={to} onChange={(e) => setTo(e.target.value)}>
              {monthOptions.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </Select>
          </Field>

          {/*
            aria-pressed rather than a tablist: these buttons do not switch
            panels, they write a value into the two selects above. The pressed
            one is the answer to "which filter am I looking at".
          */}
          <div
            role="group"
            aria-label={t.reportsUi.range}
            className="flex flex-wrap items-end gap-2 pb-0.5"
          >
            {([
              ['this', t.reportsUi.presetThisMonth],
              ['last', t.reportsUi.presetLastMonth],
              ['quarter', t.reportsUi.presetQuarter],
              ['year', t.reportsUi.presetYear],
              ['all', t.reportsUi.presetAll],
            ] as const).map(([kind, label]) => {
              const on = activePreset === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={on}
                  onClick={() => preset(kind)}
                  className={cx(
                    'rounded-full px-3.5 py-2 text-xs font-medium',
                    'transition-[background-color,color,box-shadow] duration-150 ease-soft',
                    on
                      ? 'bg-accent-soft text-accent-strong ring-1 ring-accent/25 shadow-card'
                      : 'border border-border bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink',
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/*
          The range in words, under the controls that set it. Two selects both
          reading "September" do not say "one month", and a hand-picked range
          has no pressed button to speak for it at all.
        */}
        <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-3 text-xs text-ink-muted">
          <span className="font-medium text-ink">{t.reportsUi.showing}</span>
          <span>{monthLabel(from)}</span>
          <span aria-hidden className="text-ink-faint">–</span>
          <span>{monthLabel(to)}</span>
          <span className="text-ink-faint">·</span>
          <span>
            {monthSpan === 1
              ? t.reportsUi.oneMonth
              : `${formatNumber(monthSpan, locale)} ${t.reportsUi.monthsUnit}`}
          </span>
          {activePreset === null && from <= to && (
            <Badge tone="info">{t.reportsUi.customRange}</Badge>
          )}
          {from > to && <Badge tone="danger">{t.reportsUi.rangeInverted}</Badge>}
        </p>
      </Card>

      {/* ── the period totals ────────────────────────────────────────────── */}
      <section className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label={t.reportsUi.revenue} value={formatMoney(totals.revenue, locale)} tone="ok" />
        <StatCard label={t.reportsUi.expenses} value={formatMoney(totals.expenses, locale)} tone="danger" />
        <StatCard
          label={t.reportsUi.net}
          value={formatMoney(totals.net, locale)}
          tone={totals.net < 0 ? 'danger' : 'ok'}
          emphasis
        />
        <StatCard label={t.reportsUi.fees} value={formatMoney(feesTotal, locale)} hint={t.position.fees} />
        <StatCard
          label={t.reportsUi.outstanding}
          value={formatMoney(outstanding, locale)}
          hint={t.reportsUi.balanceNote}
          tone={outstanding > 0 ? 'warn' : 'neutral'}
        />
      </section>

      {/* ── the balance question, kept visually apart from the period ────── */}
      <section className="mb-6 grid gap-4 xl:grid-cols-2">
        <MoneyPositionPanel position={position.data} loading={position.loading} />
        <Card>
          <CardHeader title={t.reports.walletBalances} hint={t.reportsUi.balanceNote} />
          {wallets.loading
            ? <Spinner label={t.common.loading} lines={4} />
            : <WalletStrip wallets={wallets.data ?? []} />}
        </Card>
      </section>

      {/* ── the report picker ────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title={active.label}
          hint={t.reportsUi.rangeNote}
          action={<Badge tone="brand">{`${monthLabel(from)} — ${monthLabel(to)}`}</Badge>}
        />

        <div
          role="tablist"
          aria-label={t.reportsUi.pick}
          className="flex flex-wrap gap-1.5 border-b border-border px-4 py-3"
        >
          {(Object.keys(REPORTS) as ReportKey[]).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={report === key}
              onClick={() => setReport(key)}
              className={cx(
                'rounded-full px-3 py-1.5 text-xs font-medium',
                'transition-[background-color,color,box-shadow] duration-150 ease-soft',
                report === key
                  ? 'bg-accent-soft text-accent-strong shadow-card'
                  : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
              )}
            >
              {REPORTS[key].label}
            </button>
          ))}
        </div>

        <DataTable
          columns={active.columns}
          rows={active.rows}
          keyOf={(_, i) => `${report}-${i}`}
          loading={active.loading}
          error={active.error}
          emptyMessage={t.reportsUi.noRows}
          loadingMessage={t.common.loading}
          errorMessage={t.common.error}
          loadingRows={6}
        />
      </Card>

      {monthRows.length === 0 && !months.loading && (
        <div className="mt-5">
          <Card><EmptyState message={t.reports.noMonths} /></Card>
        </div>
      )}
    </>
  );
}
