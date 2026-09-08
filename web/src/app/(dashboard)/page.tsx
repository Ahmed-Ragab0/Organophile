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
 * The hero shows the subtraction, not three unrelated numbers.
 *
 * Two of those numbers used to be wrong about themselves. The top line was the
 * gross figure labelled "revenue", when a fifth of it never arrives; and the
 * gateway's cut sat in the expense bar beside rent, as if it were something
 * bought. So the hero now reads down the actual chain:
 *
 *   students paid  ->  Kashier withheld  ->  reached you  ->  you spent
 *
 * Each row is a step, and the bar under it is that step's share of what the
 * students paid — which is the only figure the others can be a share of.
 */
function ProfitHero({
  paid, fees, expenses, net, profit,
}: {
  paid: number; fees: number; expenses: number; net: number; profit: number;
}) {
  const { t, locale } = useI18n();
  const scale = Math.max(paid, 1);
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / scale) * 100))}%`;

  const steps = [
    {
      key: 'paid',
      label: t.finance.studentPayments,
      hint: t.finance.studentPaymentsHint,
      value: paid,
      bar: 'bg-accent',
      tone: 'plain' as const,
    },
    {
      key: 'fees',
      label: t.finance.gatewayFees,
      hint: t.finance.feesNotExpense,
      value: -fees,
      bar: 'bg-warn',
      tone: 'danger' as const,
    },
    {
      key: 'expenses',
      label: t.finance.totalExpenses,
      hint: t.finance.expensesHint,
      value: -expenses,
      bar: 'bg-danger',
      tone: 'danger' as const,
    },
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

      <div className="divide-y divide-border">
        {steps.map((row) => (
          <div key={row.key} className="px-5 py-3.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium text-ink">{row.label}</span>
              <Money value={row.value} tone={row.tone} className="text-sm font-semibold" />
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div
                className={`h-full rounded-full transition-[width] ${row.bar}`}
                style={{ width: pct(Math.abs(row.value)) }}
              />
            </div>
            <p className="mt-1.5 text-xs text-ink-faint">{row.hint}</p>
          </div>
        ))}

        <div className="flex items-baseline justify-between gap-3 bg-surface-2 px-5 py-3.5">
          <span className="text-sm font-semibold text-ink">{t.finance.netProfit}</span>
          <Money
            value={profit}
            tone={profit < 0 ? 'danger' : 'ok'}
            className="font-display text-lg font-semibold"
          />
        </div>
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
          paid={n(k?.student_payments)}
          fees={n(k?.gateway_fees)}
          expenses={n(k?.expenses)}
          net={n(k?.net_revenue)}
          profit={n(k?.net_profit)}
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
              hint={`${monthLabel} · ${t.finance.studentPayments} ${formatMoney(n(k?.month_student_payments), locale)} · ${t.finance.afterFees} ${formatMoney(n(k?.month_gateway_fees), locale)}`}
              tone={n(k?.month_net_revenue) < 0 ? 'danger' : 'ok'}
              emphasis
            />
          </div>
          <StatCard
            label={t.finance.outstanding}
            value={formatMoney(n(k?.outstanding_amount), locale)}
            hint={n(k?.open_installment_plans) > 0
              ? `${formatNumber(n(k?.open_installment_plans), locale)} ${t.finance.openPlans}`
              : undefined}
            tone={n(k?.outstanding_amount) > 0 ? 'warn' : 'neutral'}
          />
          {/*
            What is actually in your own accounts, kept apart from what Kashier
            is still holding. A single "total balances" figure counted money
            that has not left the gateway yet, which is what made the bank
            account read as if a payment had already landed in it.
          */}
          <StatCard
            label={t.finance.inOwnWallets}
            value={formatMoney(n(k?.in_own_wallets), locale)}
            hint={n(k?.at_kashier_wallet) > 0
              ? `${t.finance.plusAtKashier} ${formatMoney(n(k?.at_kashier_wallet), locale)}`
              : undefined}
            tone={n(k?.in_own_wallets) < 0 ? 'danger' : 'neutral'}
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
