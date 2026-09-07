'use client';

import { useI18n } from '@/lib/i18n/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { formatMoney, formatNumber } from '@/lib/format';
import { Card, CardHeader, PageHeader, Spinner, ErrorState } from '@/components/ui/primitives';
import { StatCard } from '@/components/domain';
import { NetProfitChart, RevenueExpensesChart } from '@/components/charts/profit-charts';
import type { DashboardKpis, ProfitDaily } from '@/types/database';

export default function OverviewPage() {
  const { t, locale } = useI18n();

  const kpis = useSupabaseQuery<DashboardKpis>(
    (sb) => sb.from('v_dashboard_kpis').select('*').single(),
    [],
  );

  const daily = useSupabaseQuery<ProfitDaily[]>(
    (sb) => sb.from('v_profit_daily').select('*').order('day', { ascending: true }).limit(120),
    [],
  );

  if (kpis.loading) return <Spinner label={t.common.loading} />;
  if (kpis.error) return <ErrorState message={t.common.error} detail={kpis.error} />;

  const k = kpis.data;
  const revenue = Number(k?.revenue_all_time ?? 0);
  const expenses = Number(k?.expenses_all_time ?? 0);
  const netProfit = revenue - expenses;

  // The chart covers the last 30 days that actually have activity, rather than
  // a fixed calendar window that would render mostly empty early on.
  const recent = (daily.data ?? []).slice(-30);

  const unmatched = Number(k?.unmatched_payments ?? 0);
  const unpaid = Number(k?.unpaid_subscriptions ?? 0);
  const failedIngest = Number(k?.failed_ingest_events ?? 0);

  return (
    <>
      <PageHeader title={t.nav.overview} />

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t.kpi.revenueAllTime} value={formatMoney(revenue, locale)} />
        <StatCard label={t.kpi.revenueThisMonth} value={formatMoney(Number(k?.revenue_this_month ?? 0), locale)} />
        <StatCard label={t.kpi.expenses} value={formatMoney(expenses, locale)} />
        <StatCard
          label={t.kpi.netProfit}
          value={formatMoney(netProfit, locale)}
          tone={netProfit < 0 ? 'danger' : 'ok'}
        />
      </section>

      <section className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t.kpi.students} value={formatNumber(Number(k?.students_total ?? 0), locale)} />
        <StatCard label={t.kpi.subscriptions} value={formatNumber(Number(k?.subscriptions_total ?? 0), locale)} />
        <StatCard
          label={t.kpi.unmatched}
          value={formatNumber(unmatched, locale)}
          tone={unmatched > 0 ? 'warn' : 'neutral'}
        />
        <StatCard
          label={t.kpi.unpaid}
          value={formatNumber(unpaid, locale)}
          tone={unpaid > 0 ? 'warn' : 'neutral'}
        />
      </section>

      <section className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t.kpi.payoutsTransferred} value={formatMoney(Number(k?.payouts_transferred ?? 0), locale)} tone="ok" />
        <StatCard label={t.kpi.payoutsInFlight} value={formatMoney(Number(k?.payouts_in_flight ?? 0), locale)} tone="warn" />
        <StatCard
          label={t.kpi.failedIngest}
          value={formatNumber(failedIngest, locale)}
          tone={failedIngest > 0 ? 'danger' : 'ok'}
        />
      </section>

      <section className="mt-6 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title={t.charts.revenueVsExpenses} hint={t.charts.last30} />
          {daily.loading
            ? <Spinner label={t.common.loading} />
            : <RevenueExpensesChart rows={recent} />}
        </Card>

        <Card>
          <CardHeader title={t.charts.netProfitTrend} hint={t.charts.last30} />
          {daily.loading
            ? <Spinner label={t.common.loading} />
            : <NetProfitChart rows={recent} />}
        </Card>
      </section>
    </>
  );
}
