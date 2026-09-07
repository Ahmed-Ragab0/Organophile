'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { formatMoney, formatNumber } from '@/lib/format';
import {
  Card, CardHeader, EmptyState, Field, PageHeader, Select, Spinner,
} from '@/components/ui/primitives';
import { Money, StatCard, WalletStrip } from '@/components/domain';
import { FillBar } from '@/components/ui/primitives';
import type {
  ExpenseByCategory, MonthlyReport, RevenueByCourse, RevenueByUniversity, WalletBalance,
} from '@/types/database';

/** A ranked breakdown with proportional bars — readable before the numbers are. */
function Breakdown({
  title, rows, tone,
}: {
  title: string;
  rows: Array<{ key: string; label: string; value: number; sub?: string }>;
  tone: 'ok' | 'danger';
}) {
  const { t } = useI18n();
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));

  return (
    <Card>
      <CardHeader title={title} />
      {rows.length === 0 ? (
        <EmptyState message={t.common.empty} />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.key} className="px-5 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">{r.label}</p>
                  {r.sub && <p className="text-xs text-ink-faint">{r.sub}</p>}
                </div>
                <span className="shrink-0 text-sm">
                  <Money value={r.value} tone={tone === 'ok' ? 'ok' : 'danger'} />
                </span>
              </div>
              <div className="mt-2">
                <FillBar value={r.value} max={max} tone={tone} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function ReportsPage() {
  const { t, locale } = useI18n();
  const [month, setMonth] = useState<string>('');

  const months = useSupabaseQuery<MonthlyReport[]>(
    (sb) => sb.from('v_monthly_report').select('*').order('month', { ascending: false }),
    [],
  );

  const available = months.data ?? [];
  // Default to the most recent month that has data, not to today — an empty
  // report on first open would look broken rather than empty.
  const selected = month || available[0]?.month || '';
  const report = available.find((m) => m.month === selected);

  const byCategory = useSupabaseQuery<ExpenseByCategory[]>(
    (sb) => {
      let q = sb.from('v_expenses_by_category').select('*').order('total', { ascending: false });
      if (selected) q = q.eq('month', selected);
      return q;
    },
    [selected],
  );

  const byCourse = useSupabaseQuery<RevenueByCourse[]>(
    (sb) => {
      let q = sb.from('v_revenue_by_course').select('*').order('revenue', { ascending: false });
      if (selected) q = q.eq('month', selected);
      return q;
    },
    [selected],
  );

  const byUniversity = useSupabaseQuery<RevenueByUniversity[]>(
    (sb) => {
      let q = sb.from('v_revenue_by_university').select('*').order('revenue', { ascending: false });
      if (selected) q = q.eq('month', selected);
      return q;
    },
    [selected],
  );

  const wallets = useSupabaseQuery<WalletBalance[]>(
    (sb) => sb.from('v_wallet_balances').select('*').order('sort_order'),
    [],
  );

  const monthLabel = (iso: string) =>
    new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
      month: 'long', year: 'numeric', timeZone: 'Africa/Cairo',
    }).format(new Date(iso));

  if (months.loading) return <Spinner label={t.common.loading} />;

  const n = (v: number | null | undefined) => Number(v ?? 0);

  return (
    <>
      <PageHeader
        title={t.reports.title}
        subtitle={t.reports.subtitle}
        action={
          available.length > 0 ? (
            <div className="w-56">
              <Field label={t.reports.month}>
                <Select value={selected} onChange={(e) => setMonth(e.target.value)}>
                  {available.map((m) => (
                    <option key={m.month} value={m.month}>{monthLabel(m.month)}</option>
                  ))}
                </Select>
              </Field>
            </div>
          ) : undefined
        }
      />

      {available.length === 0 ? (
        <Card><EmptyState message={t.reports.noMonths} /></Card>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <StatCard
              label={t.finance.totalRevenue}
              value={formatMoney(n(report?.revenue), locale)}
              tone="ok"
            />
            <StatCard
              label={t.finance.totalExpenses}
              value={formatMoney(n(report?.expenses), locale)}
              tone="danger"
            />
            <StatCard
              label={t.finance.netProfit}
              value={formatMoney(n(report?.net_profit), locale)}
              tone={n(report?.net_profit) < 0 ? 'danger' : 'ok'}
              emphasis
            />
            <StatCard
              label={t.reports.paymentsCount}
              value={formatNumber(n(report?.payments_count), locale)}
            />
            <StatCard
              label={t.reports.paymentsTotal}
              value={formatMoney(n(report?.payments_total), locale)}
            />
          </section>

          <section className="mt-4 grid gap-4 xl:grid-cols-2">
            <Breakdown
              title={t.reports.expensesByCategory}
              tone="danger"
              rows={(byCategory.data ?? []).map((c) => ({
                key: c.category,
                label: c.category,
                value: Number(c.total ?? 0),
                sub: `${c.entries} ${t.common.rows}`,
              }))}
            />
            <Breakdown
              title={t.reports.revenueByCourse}
              tone="ok"
              rows={(byCourse.data ?? []).map((c) => ({
                key: c.course_id ?? c.course_name,
                label: c.course_name,
                value: Number(c.revenue ?? 0),
                sub: `${c.payments} ${t.reports.paymentsCount}`,
              }))}
            />
          </section>

          <section className="mt-4 grid gap-4 xl:grid-cols-2">
            <Breakdown
              title={t.reports.revenueByUniversity}
              tone="ok"
              rows={(byUniversity.data ?? []).map((u) => ({
                key: u.university_id ?? u.university_name,
                label: u.university_name,
                value: Number(u.revenue ?? 0),
                sub: `${u.payments} ${t.reports.paymentsCount}`,
              }))}
            />
            <Card>
              <CardHeader title={t.reports.walletBalances} hint={t.wallets.subtitle} />
              {wallets.loading
                ? <Spinner label={t.common.loading} />
                : <WalletStrip wallets={wallets.data ?? []} />}
            </Card>
          </section>
        </>
      )}
    </>
  );
}
