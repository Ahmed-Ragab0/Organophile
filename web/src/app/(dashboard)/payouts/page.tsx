'use client';

import { useI18n } from '@/lib/i18n/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { formatDateTime, formatMoney } from '@/lib/format';
import { Card, CardHeader, PageHeader } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/table';
import { ModeBadge, Mono, TransferBadge } from '@/components/domain';
import { StatCard } from '@/components/domain';
import type { Payout, PayoutSummary } from '@/types/database';

export default function PayoutsPage() {
  const { t, locale } = useI18n();

  const summary = useSupabaseQuery<PayoutSummary[]>(
    (sb) => sb.from('v_payout_summary').select('*').eq('mode', 'live'),
    [],
  );

  const list = useSupabaseQuery<Payout[]>(
    (sb) => sb.from('payouts').select('*').order('transfer_date', { ascending: false, nullsFirst: false }).limit(300),
    [],
  );

  const rows = list.data ?? [];
  const totalFor = (event: string) =>
    Number((summary.data ?? []).find((s) => s.event === event)?.total_amount ?? 0);

  const columns: Array<Column<Payout>> = [
    {
      key: 'date',
      header: t.payouts.date,
      render: (r) => (
        <div className="flex items-center gap-2 whitespace-nowrap">
          <span className="text-xs text-ink-muted">{formatDateTime(r.transfer_date, locale)}</span>
          <ModeBadge mode={r.mode} />
        </div>
      ),
    },
    { key: 'id', header: t.payouts.transferId, render: (r) => <Mono value={r.transfer_id} /> },
    { key: 'event', header: t.payouts.event, render: (r) => <TransferBadge event={r.event} /> },
    {
      key: 'amount',
      header: t.payouts.amount,
      numeric: true,
      render: (r) => r.amount === null ? <span className="text-ink-faint">—</span> : formatMoney(r.amount, locale),
    },
    { key: 'ref', header: t.payouts.reference, render: (r) => <Mono value={r.reference} /> },
  ];

  return (
    <>
      <PageHeader title={t.payouts.title} subtitle={t.payouts.subtitle} />

      <section className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label={t.payouts.transferred} value={formatMoney(totalFor('TRANSFERRED'), locale)} tone="ok" />
        <StatCard label={t.payouts.initiated} value={formatMoney(totalFor('INITIATED'), locale)} tone="warn" />
        <StatCard label={t.payouts.failed} value={formatMoney(totalFor('FAILED'), locale)} tone="danger" />
      </section>

      <Card>
        <CardHeader title={t.payouts.title} hint={`${rows.length} ${t.common.rows}`} />
        <DataTable
          columns={columns}
          rows={rows}
          keyOf={(r) => r.id}
          loading={list.loading}
          error={list.error}
          emptyMessage={t.common.empty}
          loadingMessage={t.common.loading}
          errorMessage={t.common.error}
        />
      </Card>
    </>
  );
}
