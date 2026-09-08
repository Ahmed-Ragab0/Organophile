'use client';

import Link from 'next/link';
import { useI18n } from '@/lib/i18n/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { formatMoney, formatNumber, formatDate } from '@/lib/format';
import {
  Card, CardHeader, ChartSkeleton, cx, ErrorState, PageHeader, PageSkeleton, Spinner,
} from '@/components/ui/primitives';
import { MoneyModeNotice } from '@/components/money-mode-notice';
import { Money, StatCard, WalletStrip } from '@/components/domain';
import { NetProfitChart, RevenueExpensesChart } from '@/components/charts/profit-charts';
import type {
  DashboardKpis, FinanceDaily, KashierAccount, WalletBalance,
} from '@/types/database';

/**
 * The hero shows the subtraction, not three unrelated numbers: revenue and
 * expenses as opposing bars either side of the net figure, so the shape of the
 * month is readable before any digit is.
 */
function ProfitHero({
  revenue, fees, expenses, net,
}: { revenue: number; fees: number; expenses: number; net: number }) {
  const { t, locale } = useI18n();
  const scale = Math.max(revenue, 1);

  /*
   * One hero, showing the subtraction that produces the only figure that
   * matters: what reaches the account.
   *
   * This page previously led with net profit and repeated revenue, expenses
   * and the net-after-Kashier figure across the tiles below — the same five
   * numbers, three times over. A number shown twice is not reassurance, it is
   * a second thing to reconcile.
   */
  const parts = [
    { key: 'revenue', label: t.finance.totalRevenue, value: revenue, bar: 'bg-ok', tone: 'ok' as const },
    { key: 'fees', label: t.reportsUi.fees, value: fees, bar: 'bg-warn', tone: 'danger' as const },
    { key: 'expenses', label: t.finance.totalExpenses, value: expenses, bar: 'bg-danger', tone: 'danger' as const },
  ];

  return (
    <Card className="overflow-hidden">
      <div className="brand-ramp px-6 py-5">
        <p className="text-xs font-medium text-white/70">{t.finance.netRevenue}</p>
        <p className="mt-1 font-display text-4xl font-semibold text-white tnum sm:text-5xl">
          {formatMoney(net, locale)}
        </p>
        <p className="mt-1 text-xs text-white/70">{t.finance.netRevenueHint}</p>
      </div>

      <div className="grid gap-4 p-5 sm:grid-cols-3">
        {parts.map((p) => (
          <div key={p.key}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium text-ink-muted">{p.label}</span>
              <Money value={p.value} tone={p.tone} className="text-sm font-semibold" />
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-3">
              <div
                className={`h-full rounded-full transition-[width] ${p.bar}`}
                style={{ width: `${Math.min(100, (p.value / scale) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function OverviewPage() {
  const { t, locale } = useI18n();

  const kpis = useSupabaseQuery<DashboardKpis>(
    (sb) => sb.from('v_dashboard_kpis').select('*').single(),
    [],
  );

  const wallets = useSupabaseQuery<WalletBalance[]>(
    (sb) => sb.from('v_wallet_balances').select('*').order('sort_order'),
    [],
  );

  const daily = useSupabaseQuery<FinanceDaily[]>(
    (sb) => sb.from('v_finance_daily').select('*').order('day', { ascending: true }).limit(180),
    [],
  );

  const account = useSupabaseQuery<KashierAccount[]>(
    (sb) => sb.from('kashier_account').select('*').eq('mode', 'live'),
    [],
  );

  if (kpis.loading) return <PageSkeleton label={t.common.loading} />;
  if (kpis.error) return <ErrorState message={t.common.error} detail={kpis.error} />;

  const k = kpis.data;
  const n = (v: number | null | undefined) => Number(v ?? 0);
  const recent = (daily.data ?? []).slice(-30);
  const kashier = (account.data ?? [])[0];

  const monthLabel = k?.current_month
    ? new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
        month: 'long', year: 'numeric', timeZone: 'Africa/Cairo',
      }).format(new Date(k.current_month))
    : '';

  const needsAttention =
    n(k?.unmatched_payments) + n(k?.unpaid_subscriptions) + n(k?.failed_ingest_events) > 0;

  return (
    <>
      <PageHeader eyebrow={t.navGroups.money} title={t.nav.overview} />

      <MoneyModeNotice />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <ProfitHero
          revenue={n(k?.total_revenue)}
          fees={n(k?.gateway_fees)}
          expenses={n(k?.total_expenses)}
          net={n(k?.net_after_everything)}
        />

        {/*
          Everything here is a different question from the hero, not a
          restatement of it: this month, what is still owed, what is in the
          wallets, and how many people and orders that represents.
        */}
        <div className="grid grid-cols-2 gap-3 content-start">
          <div className="col-span-2">
            <StatCard
              label={t.finance.monthNetRevenue}
              value={formatMoney(n(k?.month_net_revenue), locale)}
              hint={`${monthLabel} · ${t.finance.afterFees} ${formatMoney(n(k?.month_gateway_fees), locale)}`}
              tone={n(k?.month_net_revenue) < 0 ? 'danger' : 'ok'}
              emphasis
            />
          </div>
          <StatCard
            label={t.finance.outstanding}
            value={formatMoney(n(k?.outstanding_amount), locale)}
            tone={n(k?.outstanding_amount) > 0 ? 'warn' : 'neutral'}
          />
          <StatCard
            label={t.finance.walletsTotal}
            value={formatMoney(n(k?.wallets_total), locale)}
            tone={n(k?.wallets_total) < 0 ? 'danger' : 'neutral'}
          />
          <StatCard
            label={t.finance.studentsActive}
            value={`${formatNumber(n(k?.students_active), locale)} ${t.finance.ofTotal} ${formatNumber(n(k?.students_total), locale)}`}
          />
          <StatCard
            label={t.nav.subscriptions}
            value={formatNumber(n(k?.subscriptions_total), locale)}
          />
        </div>
      </div>

      <section className="mt-6">
        <Card>
          <CardHeader
            title={t.wallets.title}
            hint={t.wallets.subtitle}
            action={
              <Link
                href="/wallets"
                className="text-xs font-medium text-accent-strong hover:underline"
              >
                {t.common.view} →
              </Link>
            }
          />
          {wallets.loading
            ? <Spinner label={t.common.loading} />
            : <WalletStrip wallets={wallets.data ?? []} />}
        </Card>
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title={t.charts.revenueVsExpenses} hint={t.charts.last30} />
          {daily.loading
            ? <ChartSkeleton label={t.common.loading} />
            : <RevenueExpensesChart rows={recent} />}
        </Card>
        <Card>
          <CardHeader title={t.charts.netProfitTrend} hint={t.charts.last30} />
          {daily.loading
            ? <ChartSkeleton label={t.common.loading} />
            : <NetProfitChart rows={recent} />}
        </Card>
      </section>

      {/* Kashier: what they still hold, and what is on its way. */}
      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title={t.finance.kashierBalance}
            hint={
              kashier?.synced_at
                ? `${t.finance.syncedAt}: ${formatDate(kashier.synced_at, locale)}`
                : t.finance.neverSynced
            }
            action={
              <Link href="/payouts" className="text-xs font-medium text-accent-strong hover:underline">
                {t.common.view} →
              </Link>
            }
          />
          <div className="grid grid-cols-2 gap-4 p-5">
            <div>
              <p className="text-xs text-ink-muted">{t.finance.availableBalance}</p>
              <p className="mt-1 font-display text-xl font-semibold text-ink tnum">
                {formatMoney(n(kashier?.available_balance), locale)}
              </p>
            </div>
            <div>
              <p className="text-xs text-ink-muted">{t.finance.payoutsInFlight}</p>
              <p className="mt-1 font-display text-xl font-semibold text-warn tnum">
                {formatMoney(n(k?.payouts_in_flight), locale)}
              </p>
            </div>
            <div>
              <p className="text-xs text-ink-muted">{t.finance.payoutsReceived}</p>
              <p className="mt-1 font-display text-xl font-semibold text-ok tnum">
                {formatMoney(n(k?.payouts_received), locale)}
              </p>
            </div>
            <div>
              <p className="text-xs text-ink-muted">{t.finance.lastTransfer}</p>
              <p className="mt-1 font-display text-xl font-semibold text-ink tnum">
                {formatMoney(n(kashier?.last_transfer), locale)}
              </p>
            </div>
          </div>
        </Card>

        <Card className={cx(needsAttention && 'ring-1 ring-warn/30')}>
          <CardHeader title={t.health.title} hint={t.health.subtitle} />
          <div className="divide-y divide-border">
            {[
              { label: t.kpi.unmatched, value: n(k?.unmatched_payments), href: '/reconciliation' },
              { label: t.kpi.unpaid, value: n(k?.unpaid_subscriptions), href: '/reconciliation' },
              { label: t.kpi.failedIngest, value: n(k?.failed_ingest_events), href: '/health' },
            ].map((row) => (
              <Link
                key={row.label}
                href={row.href}
                className="flex items-center justify-between px-5 py-3.5 hover:bg-surface-2"
              >
                <span className="text-sm text-ink-muted">{row.label}</span>
                <span
                  className={cx(
                    'font-display text-lg font-semibold tnum',
                    row.value > 0 ? 'text-warn' : 'text-ok',
                  )}
                >
                  {formatNumber(row.value, locale)}
                </span>
              </Link>
            ))}
          </div>
        </Card>
      </section>
    </>
  );
}
