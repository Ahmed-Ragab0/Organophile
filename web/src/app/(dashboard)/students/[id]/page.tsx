'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { useState } from 'react';
import {
  Button, Card, CardHeader, ErrorState, PageHeader, PageSkeleton,
} from '@/components/ui/primitives';
import { LedgerDetailModal } from '@/components/ledger-detail';
import { PlanTotalInput } from '@/components/plan-total';
import { DataTable, type Column } from '@/components/ui/table';
import {
  InstallmentPips, LedgerTypeBadge, Money, Mono, PaymentStatusBadge, PlanStatusBadge,
  SignedMoney, StatCard,
} from '@/components/domain';
import type {
  InstallmentPlan, LedgerEntry, StudentFinancials, SubscriptionFinancials,
} from '@/types/database';

type SubscriptionRow = SubscriptionFinancials & {
  course_name?: string | null;
  package_name?: string | null;
};

export default function StudentDetailPage() {
  const { t, locale } = useI18n();
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [detail, setDetail] = useState<LedgerEntry | null>(null);

  const student = useSupabaseQuery<StudentFinancials>(
    (sb) => sb.from('v_student_financials').select('*').eq('student_id', id).single(),
    [id],
  );

  const subscriptions = useSupabaseQuery<SubscriptionRow[]>(
    (sb) =>
      sb.from('v_subscription_financials').select('*')
        .eq('student_id', id)
        .order('enrolled_at', { ascending: false }),
    [id],
  );

  const plans = useSupabaseQuery<InstallmentPlan[]>(
    (sb) =>
      sb.from('v_installment_plans').select('*')
        .eq('student_id', id)
        .order('started_at', { ascending: false }),
    [id],
  );

  const entries = useSupabaseQuery<LedgerEntry[]>(
    (sb) =>
      sb.from('v_ledger').select('*')
        .eq('student_id', id)
        .is('voided_at', null)
        .order('occurred_at', { ascending: false })
        .limit(100),
    [id],
  );

  if (student.loading) return <PageSkeleton label={t.common.loading} />;
  if (student.error) return <ErrorState message={t.common.error} detail={student.error} />;

  const s = student.data;
  if (!s) return <ErrorState message={t.common.empty} />;

  const n = (v: number | null | undefined) => Number(v ?? 0);

  const subColumns: Array<Column<SubscriptionRow>> = [
    { key: 'order', header: t.subscriptions.orderId, render: (r) => <Mono value={r.order_id} /> },
    {
      key: 'enrolled', header: t.studentDetail.registeredAt,
      render: (r) => (
        <span className="text-xs text-ink-muted">{formatDate(r.enrolled_at, locale)}</span>
      ),
    },
    {
      key: 'installments', header: t.studentDetail.installments, numeric: true,
      render: (r) => <span className="tnum">{r.installment_count}</span>,
    },
    {
      key: 'due', header: t.studentDetail.totalDue, numeric: true,
      render: (r) => <Money value={n(r.total_due)} tone="plain" />,
    },
    {
      key: 'paid', header: t.studentDetail.totalPaid, numeric: true,
      render: (r) => <Money value={n(r.total_paid)} tone="ok" />,
    },
    {
      key: 'remaining', header: t.studentDetail.remaining, numeric: true,
      render: (r) => (
        <Money value={n(r.remaining)} tone={n(r.remaining) > 0 ? 'danger' : 'plain'} />
      ),
    },
    {
      key: 'status', header: t.studentDetail.status,
      render: (r) => <PaymentStatusBadge status={r.payment_status} />,
    },
  ];

  const entryColumns: Array<Column<LedgerEntry>> = [
    {
      key: 'date', header: t.ledger.date,
      render: (r) => (
        <span className="text-xs whitespace-nowrap text-ink-muted">
          {formatDateTime(r.occurred_at, locale)}
        </span>
      ),
    },
    { key: 'type', header: t.ledger.type, render: (r) => <LedgerTypeBadge type={r.entry_type} /> },
    {
      key: 'description', header: t.ledger.description,
      render: (r) => r.description ?? <span className="text-ink-faint">—</span>,
    },
    { key: 'wallet', header: t.ledger.wallet, render: (r) => r.wallet_name },
    {
      key: 'effect', header: t.ledger.effect, numeric: true,
      render: (r) => <SignedMoney value={n(r.wallet_delta)} />,
    },
    {
      key: 'detail', header: '',
      render: (r) => (
        <Button size="sm" variant="secondary" onClick={() => setDetail(r)}>
          {t.ledgerDetail.open}
        </Button>
      ),
    },
  ];

  return (
    <>
      <div className="mb-4">
        <Link href="/students" className="text-xs text-ink-muted hover:text-ink">
          ← {t.studentDetail.backToStudents}
        </Link>
      </div>

      <PageHeader
        title={s.name}
        subtitle={[s.phone, s.university_name, s.group_name].filter(Boolean).join(' · ')}
        action={<PaymentStatusBadge status={s.payment_status} />}
      />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={t.studentDetail.totalDue}
          value={formatMoney(n(s.total_due), locale)}
        />
        <StatCard
          label={t.studentDetail.totalPaid}
          value={formatMoney(n(s.total_paid), locale)}
          tone="ok"
        />
        <StatCard
          label={t.studentDetail.remaining}
          value={formatMoney(n(s.remaining), locale)}
          tone={n(s.remaining) > 0 ? 'danger' : 'ok'}
          emphasis
        />
        <StatCard
          label={t.studentDetail.lastPayment}
          value={s.last_payment_at ? formatDate(s.last_payment_at, locale) : '—'}
          hint={`${t.studentDetail.registeredAt}: ${formatDate(s.registered_at, locale)}`}
        />
      </section>

      {/*
        The instalment plans, above the subscription list rather than inside it.
        Each instalment is its own subscription row and each is settled by its
        own payment; the debt that survives them all lives here, and putting it
        below rows that all read "paid" would bury the only figure that answers
        what this student still owes.
      */}
      {(plans.data ?? []).length > 0 && (
        <section className="mt-4">
          <Card>
            <CardHeader title={t.plans.title} hint={t.plans.subtitle} />
            <div className="divide-y divide-border">
              {(plans.data ?? []).map((pl) => (
                <div key={pl.plan_id} className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-ink">
                        {pl.course_name ?? pl.package_name ?? t.common.empty}
                      </p>
                      <div className="mt-1.5">
                        <InstallmentPips
                          paid={pl.installments_paid}
                          total={pl.installment_count}
                        />
                      </div>
                    </div>
                    <PlanStatusBadge status={pl.status} />
                  </div>

                  <div className="mt-4 grid gap-4 sm:grid-cols-3">
                    <div>
                      <p className="text-xs text-ink-muted">{t.plans.totalDue}</p>
                      {/* Editable here because this is where you find out it is
                          wrong: looking at one student and knowing what they
                          agreed to pay. The package price covers the general
                          case; this is the exception. */}
                      <PlanTotalInput
                        planId={pl.plan_id}
                        value={pl.total_due}
                        onSaved={() => plans.reload()}
                      />
                    </div>
                    <div>
                      <p className="text-xs text-ink-muted">{t.plans.totalPaid}</p>
                      <p className="mt-0.5 font-display text-lg font-semibold text-ok tnum">
                        {formatMoney(Number(pl.total_paid), locale)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-ink-muted">{t.plans.remaining}</p>
                      <p className="mt-0.5 font-display text-lg font-semibold text-warn tnum">
                        {pl.remaining === null ? '—' : formatMoney(Number(pl.remaining), locale)}
                      </p>
                    </div>
                  </div>

                  <p className="mt-3 text-xs text-ink-faint">
                    {pl.total_due === null
                      ? t.plans.priceUnknownHint
                      : pl.next_installment_amount === null
                        ? t.plans.statuses[pl.status]
                        : `${t.plans.nextAmount}: ${formatMoney(Number(pl.next_installment_amount), locale)}`
                          + ` · ${pl.installments_remaining} ${t.plans.remainingCount}`}
                  </p>
                </div>
              ))}
            </div>
          </Card>
        </section>
      )}

      <section className="mt-4">
        <Card>
          <CardHeader
            title={t.studentDetail.subscriptions}
            hint={`${s.subscriptions_count} ${t.common.rows}`}
          />
          <DataTable
            columns={subColumns}
            rows={subscriptions.data ?? []}
            keyOf={(r) => r.subscription_id}
            loading={subscriptions.loading}
            error={subscriptions.error}
            emptyMessage={t.common.empty}
            loadingMessage={t.common.loading}
            errorMessage={t.common.error}
          />
        </Card>
      </section>

      <section className="mt-4">
        <Card>
          <CardHeader title={t.studentDetail.ledger} />
          <DataTable
            columns={entryColumns}
            rows={entries.data ?? []}
            keyOf={(r) => r.id}
            loading={entries.loading}
            error={entries.error}
            emptyMessage={t.common.empty}
            loadingMessage={t.common.loading}
            errorMessage={t.common.error}
          />
        </Card>
      </section>

      <LedgerDetailModal entry={detail} onClose={() => setDetail(null)} />
    </>
  );
}
