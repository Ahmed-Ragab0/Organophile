'use client';

import { useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { downloadCsv, formatDateTime, formatMoney, toCsv } from '@/lib/format';
import { Button, Card, CardHeader, Field, Input, PageHeader, Select } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/table';
import { EventBadge, MatchBadge, ModeBadge, Mono, SignedMoney, StatusBadge } from '@/components/domain';
import type { EnrichedPayment, KashierTxnEvent, TxnStatus } from '@/types/database';

const PAGE_SIZE = 100;

const STATUSES: TxnStatus[] = [
  'SUCCESS', 'FAILURE', 'PENDING', 'INITIATED', 'EXPIRED', 'CANCEL', 'REVOKED', 'UNKNOWN',
];
const EVENTS: KashierTxnEvent[] = ['pay', 'capture', 'authorize', 'refund', 'void', 'reversal'];

export default function PaymentsPage() {
  const { t, locale } = useI18n();

  const [status, setStatus] = useState('');
  const [event, setEvent] = useState('');
  const [mode, setMode] = useState('live');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  const { data, loading, error } = useSupabaseQuery<EnrichedPayment[]>(
    (sb) => {
      let q = sb
        .from('v_payments_enriched')
        .select('*')
        .order('transaction_date', { ascending: false, nullsFirst: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

      if (status) q = q.eq('status', status);
      if (event) q = q.eq('event', event);
      if (mode) q = q.eq('mode', mode);
      if (from) q = q.gte('transaction_date', `${from}T00:00:00Z`);
      // `to` is inclusive of the whole day, which is what a person picking a
      // date on a filter means.
      if (to) q = q.lte('transaction_date', `${to}T23:59:59Z`);
      if (search.trim()) {
        const s = search.trim();
        q = q.or(
          `transaction_id.ilike.%${s}%,merchant_order_id.ilike.%${s}%,student_name.ilike.%${s}%,student_phone.ilike.%${s}%`,
        );
      }
      return q;
    },
    [status, event, mode, from, to, search, page],
  );

  const rows = useMemo(() => data ?? [], [data]);

  const columns: Array<Column<EnrichedPayment>> = [
    {
      key: 'date',
      header: t.payments.date,
      render: (r) => (
        <div className="flex items-center gap-2 whitespace-nowrap">
          <span className="text-xs text-ink-muted">{formatDateTime(r.transaction_date, locale)}</span>
          <ModeBadge mode={r.mode} />
        </div>
      ),
    },
    { key: 'txn', header: t.payments.transactionId, render: (r) => <Mono value={r.transaction_id} /> },
    { key: 'order', header: t.payments.orderId, render: (r) => <Mono value={r.merchant_order_id} /> },
    {
      key: 'student',
      header: t.payments.student,
      render: (r) =>
        r.student_name
          ? (
            <div className="min-w-0">
              <p className="truncate text-ink">{r.student_name}</p>
              {r.student_phone && (
                <p className="ltr-id truncate text-xs text-ink-faint">{r.student_phone}</p>
              )}
            </div>
          )
          : <span className="text-ink-faint">—</span>,
    },
    {
      key: 'course',
      header: t.payments.course,
      render: (r) => r.course_name ?? <span className="text-ink-faint">—</span>,
    },
    { key: 'event', header: t.payments.event, render: (r) => <EventBadge event={r.event} /> },
    { key: 'status', header: t.payments.status, render: (r) => <StatusBadge status={r.status} /> },
    { key: 'amount', header: t.payments.amount, numeric: true, render: (r) => <SignedMoney value={r.signed_amount} /> },
    {
      key: 'settled',
      header: t.payments.settled,
      numeric: true,
      render: (r) =>
        r.settled_amount === null
          ? <span className="text-ink-faint">—</span>
          : <span className="tnum text-ink-muted">{formatMoney(r.settled_amount, locale)}</span>,
    },
    { key: 'match', header: t.payments.match, render: (r) => <MatchBadge method={r.match_method} /> },
    {
      key: 'card',
      header: t.payments.card,
      render: (r) =>
        r.masked_card
          ? (
            <span className="whitespace-nowrap text-xs text-ink-muted">
              {r.card_brand} <span className="ltr-id">{r.masked_card}</span>
            </span>
          )
          : <span className="text-ink-faint">{r.method ?? '—'}</span>,
    },
  ];

  function exportCsv() {
    const cols = [
      'transaction_date', 'transaction_id', 'merchant_order_id', 'student_name',
      'student_phone', 'course_name', 'event', 'status', 'amount', 'signed_amount',
      'settled_amount', 'fees', 'currency', 'method', 'card_brand', 'masked_card',
      'match_method', 'mode',
    ];
    downloadCsv(`payments-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows, cols));
  }

  function resetPageAnd(setter: (v: string) => void) {
    return (v: string) => { setPage(0); setter(v); };
  }

  return (
    <>
      <PageHeader
        title={t.payments.title}
        subtitle={t.payments.subtitle}
        action={<Button variant="secondary" onClick={exportCsv}>{t.common.export}</Button>}
      />

      <Card className="mb-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <Field label={t.common.search}>
            <Input
              value={search}
              placeholder="TRX / ORDER / 010…"
              onChange={(e) => resetPageAnd(setSearch)(e.target.value)}
            />
          </Field>
          <Field label={t.payments.status}>
            <Select value={status} onChange={(e) => resetPageAnd(setStatus)(e.target.value)}>
              <option value="">{t.common.all}</option>
              {STATUSES.map((s) => <option key={s} value={s}>{t.status[s]}</option>)}
            </Select>
          </Field>
          <Field label={t.payments.event}>
            <Select value={event} onChange={(e) => resetPageAnd(setEvent)(e.target.value)}>
              <option value="">{t.common.all}</option>
              {EVENTS.map((ev) => <option key={ev} value={ev}>{t.events[ev]}</option>)}
            </Select>
          </Field>
          <Field label={t.common.mode}>
            <Select value={mode} onChange={(e) => resetPageAnd(setMode)(e.target.value)}>
              <option value="live">{t.common.live}</option>
              <option value="test">{t.common.test}</option>
              <option value="">{t.common.all}</option>
            </Select>
          </Field>
          <Field label={t.common.from}>
            <Input type="date" value={from} onChange={(e) => resetPageAnd(setFrom)(e.target.value)} />
          </Field>
          <Field label={t.common.to}>
            <Input type="date" value={to} onChange={(e) => resetPageAnd(setTo)(e.target.value)} />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader
          title={t.payments.title}
          hint={`${rows.length} ${t.common.rows}`}
          action={
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                {t.common.prev}
              </Button>
              <span className="text-xs text-ink-muted tnum">{page + 1}</span>
              <Button
                size="sm"
                variant="secondary"
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
          keyOf={(r, i) => r.id ?? String(i)}
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
