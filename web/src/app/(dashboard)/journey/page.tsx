'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useMode } from '@/lib/mode/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { downloadCsv, formatDate, formatMoney, toCsv } from '@/lib/format';
import {
  Badge, Button, Card, CardHeader, Field, Input, Notice, PageHeader, Select, cx,
} from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/table';
import { Money, Mono, StatCard } from '@/components/domain';
import type { GatewayStage, OrderJourney, PayoutStage } from '@/types/database';

/**
 * The one question this system exists to answer:
 *
 *   someone bought a course on ukkera — did they actually pay, did Kashier
 *   receive it, and has it reached my bank?
 *
 * Those are three separate systems with three separate vocabularies, and until
 * now answering it meant three separate pages. This is one row per order with
 * all three stages on it.
 */

const GATEWAY_TONE: Record<GatewayStage, 'danger' | 'warn' | 'ok'> = {
  not_paid: 'danger',
  part_paid: 'warn',
  paid: 'ok',
};

const PAYOUT_TONE: Record<PayoutStage, 'neutral' | 'warn' | 'info' | 'ok'> = {
  none: 'neutral',
  at_kashier: 'warn',
  partially_paid_out: 'info',
  paid_out: 'ok',
};

/**
 * The three stages as a track, not three badges.
 *
 * A row of chips says what each stage is. A connected track says how far the
 * order got, which is the thing you actually scan a list of orders for.
 */
function StageTrack({ row }: { row: OrderJourney }) {
  const { t } = useI18n();

  const reachedGateway = row.gateway_stage !== 'not_paid';
  const reachedBank = row.payout_stage === 'paid_out';
  const partialBank = row.payout_stage === 'partially_paid_out';

  const steps = [
    { done: true, label: t.journey.stageOrdered, tone: 'bg-ok' },
    {
      done: reachedGateway,
      label: t.journey.stagePaid,
      tone: row.gateway_stage === 'paid' ? 'bg-ok' : row.gateway_stage === 'part_paid' ? 'bg-warn' : 'bg-border-strong',
    },
    {
      done: reachedBank || partialBank,
      label: t.journey.stagePayout,
      tone: reachedBank ? 'bg-ok' : partialBank ? 'bg-info' : 'bg-border-strong',
    },
  ];

  return (
    <div className="flex items-center gap-1.5" title={steps.map((s) => s.label).join(' → ')}>
      {steps.map((s, i) => (
        <span key={s.label} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={cx('h-1.5 w-6 rounded-full transition-colors', s.done ? s.tone : 'bg-border')}
          />
          {i < steps.length - 1 && <span aria-hidden className="text-[0.6rem] text-ink-faint">›</span>}
        </span>
      ))}
      <span className="sr-only">
        {steps.filter((s) => s.done).map((s) => s.label).join(' · ')}
      </span>
    </div>
  );
}

export default function JourneyPage() {
  const { t, locale } = useI18n();
  const { mode } = useMode();

  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('');

  const { data, loading, error } = useSupabaseQuery<OrderJourney[]>(
    (sb) => sb.from('v_order_journey').select('*').order('ordered_at', { ascending: false }).limit(500),
    [],
  );

  const all = data ?? [];

  // An order with no payment at all has no mode of its own, so it belongs in
  // both views — you still need to see that nobody paid for it.
  const rows = all.filter((r) => {
    if (r.latest_mode !== null && r.latest_mode !== mode) return false;

    const q = search.trim().toLowerCase();
    if (q &&
        !(r.student_name ?? '').toLowerCase().includes(q) &&
        !r.order_id.toLowerCase().includes(q) &&
        !(r.latest_transaction_id ?? '').toLowerCase().includes(q)) return false;

    if (stage === 'not_paid' && r.gateway_stage !== 'not_paid') return false;
    if (stage === 'part_paid' && r.gateway_stage !== 'part_paid') return false;
    if (stage === 'at_kashier' && r.payout_stage !== 'at_kashier') return false;
    if (stage === 'paid_out' && r.payout_stage !== 'paid_out') return false;
    if (stage === 'unmatched' && r.match_method !== 'none') return false;
    return true;
  });

  const totals = rows.reduce(
    (a, r) => ({
      due: a.due + Number(r.total_due ?? 0),
      paid: a.paid + Number(r.total_paid ?? 0),
      atKashier: a.atKashier + (r.payout_stage === 'at_kashier' ? Number(r.paid_settled ?? 0) : 0),
      unpaid: a.unpaid + (r.gateway_stage === 'not_paid' ? 1 : 0),
    }),
    { due: 0, paid: 0, atKashier: 0, unpaid: 0 },
  );

  const columns: Array<Column<OrderJourney>> = [
    {
      key: 'student',
      header: t.journey.openStudent,
      render: (r) => (
        <div className="min-w-0">
          {r.student_id ? (
            <Link
              href={`/students/${r.student_id}`}
              className="truncate font-medium text-ink hover:text-accent-strong"
            >
              {r.student_name ?? '—'}
            </Link>
          ) : (
            <p className="truncate font-medium text-ink">{r.student_name ?? '—'}</p>
          )}
          <Link href={`/pricing/${r.subscription_id}`} className="hover:text-accent-strong">
            <Mono value={r.order_id} />
          </Link>
        </div>
      ),
    },
    {
      key: 'course',
      header: t.subscriptions.course,
      render: (r) => (
        <div className="min-w-0">
          <p className="truncate text-ink">{r.course_name ?? '—'}</p>
          {r.package_name && <p className="truncate text-xs text-ink-faint">{r.package_name}</p>}
        </div>
      ),
    },
    { key: 'track', header: t.journey.stages, render: (r) => <StageTrack row={r} /> },
    {
      key: 'gateway',
      header: t.journey.stagePaid,
      render: (r) => (
        <Badge tone={GATEWAY_TONE[r.gateway_stage]}>
          {r.gateway_stage === 'paid' ? t.journey.paid
            : r.gateway_stage === 'part_paid' ? t.journey.partPaid
            : t.journey.notPaid}
        </Badge>
      ),
    },
    {
      key: 'payout',
      header: t.journey.stagePayout,
      render: (r) => (
        <Badge tone={PAYOUT_TONE[r.payout_stage]}>
          {r.payout_stage === 'paid_out' ? t.journey.paidOut
            : r.payout_stage === 'partially_paid_out' ? t.journey.partiallyPaidOut
            : r.payout_stage === 'at_kashier' ? t.journey.atKashier
            : t.journey.payoutNone}
        </Badge>
      ),
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
      key: 'settled', header: t.journey.settled, numeric: true,
      render: (r) => r.paid_settled === null
        ? <span className="text-ink-faint">—</span>
        : (
          <div>
            <Money value={Number(r.paid_settled)} tone="plain" />
            {Number(r.paid_fees ?? 0) > 0 && (
              <p className="text-xs text-ink-faint">
                −{formatMoney(Number(r.paid_fees), locale)}
              </p>
            )}
          </div>
        ),
    },
    {
      key: 'txn',
      header: t.journey.transaction,
      render: (r) => (
        <div className="min-w-0">
          <Mono value={r.latest_transaction_id} />
          {r.match_method === 'none' && r.kashier_payments === 0 && (
            <p className="text-xs text-ink-faint">{formatDate(r.ordered_at, locale)}</p>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow={t.navGroups.ops}
        title={t.journey.title}
        subtitle={t.journey.subtitle}
        action={
          <Button
            variant="secondary"
            onClick={() =>
              downloadCsv(
                `journey-${new Date().toISOString().slice(0, 10)}.csv`,
                toCsv(rows as unknown as Array<Record<string, unknown>>, [
                  'order_id', 'student_name', 'student_phone', 'course_name', 'package_name',
                  'total_due', 'total_paid', 'remaining', 'paid_settled', 'paid_fees',
                  'gateway_stage', 'payout_stage', 'latest_transaction_id', 'match_method',
                  'ordered_at', 'last_payment_at',
                ]),
              )}
          >
            {t.common.export}
          </Button>
        }
      />

      <section className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={t.studentDetail.totalDue} value={formatMoney(totals.due, locale)} />
        <StatCard label={t.studentDetail.totalPaid} value={formatMoney(totals.paid, locale)} tone="ok" />
        <StatCard
          label={t.journey.atKashier}
          value={formatMoney(totals.atKashier, locale)}
          hint={t.journey.estimate}
          tone={totals.atKashier > 0 ? 'warn' : 'neutral'}
          emphasis
        />
        <StatCard
          label={t.journey.notPaid}
          value={String(totals.unpaid)}
          tone={totals.unpaid > 0 ? 'danger' : 'neutral'}
        />
      </section>

      <div className="mb-5">
        <Notice tone="info">{t.journey.estimateHint}</Notice>
      </div>

      <Card className="mb-5 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t.common.search} hint={t.journey.searchHint}>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="أحمد / YOK-…" />
          </Field>
          <Field label={t.journey.filterStage}>
            <Select value={stage} onChange={(e) => setStage(e.target.value)}>
              <option value="">{t.journey.allStages}</option>
              <option value="not_paid">{t.journey.notPaid}</option>
              <option value="part_paid">{t.journey.partPaid}</option>
              <option value="at_kashier">{t.journey.atKashier}</option>
              <option value="paid_out">{t.journey.paidOut}</option>
              <option value="unmatched">{t.journey.notMatched}</option>
            </Select>
          </Field>
          <div className="flex items-end pb-1">
            <Button variant="ghost" onClick={() => { setSearch(''); setStage(''); }}>
              {t.common.reset}
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title={t.journey.title}
          hint={`${rows.length} ${t.journey.ordersCount}`}
          action={<Badge tone={mode === 'test' ? 'warn' : 'ok'}>{t.mode[mode]}</Badge>}
        />
        <DataTable
          columns={columns}
          rows={rows}
          keyOf={(r) => r.subscription_id}
          loading={loading}
          error={error}
          emptyMessage={t.common.empty}
          loadingMessage={t.common.loading}
          errorMessage={t.common.error}
        />
      </Card>
    </>
  );
}
