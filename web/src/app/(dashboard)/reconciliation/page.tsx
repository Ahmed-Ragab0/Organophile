'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { useMode } from '@/lib/mode/context';
import { createClient } from '@/lib/supabase/client';
import { formatDateTime, formatMoney } from '@/lib/format';
import { Button, Card, CardHeader, Field, Input, PageHeader, Select } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/table';
import { Mono, SignedMoney, StatCard } from '@/components/domain';
import type { EnrichedPayment, UnpaidSubscription } from '@/types/database';

/**
 * The two directions of reconciliation, side by side.
 *
 * The manual link writes a row into `payment_subscription_overrides`, which the
 * matching view prefers over the automatic order-id join. That is the escape
 * hatch for the unverified assumption that ukkera's order_id always equals
 * Kashier's merchantOrderId.
 */
export default function ReconciliationPage() {
  const { t, locale } = useI18n();
  const { mode } = useMode();
  const [linking, setLinking] = useState<string | null>(null);
  const [pickedSubscription, setPickedSubscription] = useState('');
  const [reason, setReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const unmatched = useSupabaseQuery<EnrichedPayment[]>(
    (sb) =>
      sb.from('v_unmatched_payments').select('*').eq('mode', mode)
        .order('transaction_date', { ascending: false, nullsFirst: false }).limit(200),
    [version, mode],
  );

  const unpaid = useSupabaseQuery<UnpaidSubscription[]>(
    (sb) =>
      sb.from('v_unpaid_subscriptions').select('*')
        .order('created_at', { ascending: false }).limit(200),
    [version],
  );

  async function link(paymentId: string) {
    if (!pickedSubscription) return;
    setActionError(null);

    const supabase = createClient();
    const { data: auth } = await supabase.auth.getUser();
    const { error } = await supabase.from('payment_subscription_overrides').upsert({
      payment_id: paymentId,
      subscription_id: pickedSubscription,
      reason: reason.trim() || null,
      created_by: auth.user?.id ?? null,
    });

    if (error) {
      setActionError(error.message);
      return;
    }
    setLinking(null);
    setPickedSubscription('');
    setReason('');
    setVersion((v) => v + 1);
  }

  const unmatchedCols: Array<Column<EnrichedPayment>> = [
    { key: 'date', header: t.payments.date, render: (r) => <span className="text-xs text-ink-muted">{formatDateTime(r.transaction_date, locale)}</span> },
    { key: 'txn', header: t.payments.transactionId, render: (r) => <Mono value={r.transaction_id} /> },
    { key: 'order', header: t.payments.orderId, render: (r) => <Mono value={r.merchant_order_id} /> },
    { key: 'amount', header: t.payments.amount, numeric: true, render: (r) => <SignedMoney value={r.signed_amount} /> },
    {
      key: 'action',
      header: '',
      render: (r) => (
        <Button size="sm" variant="secondary" onClick={() => { setLinking(r.id); setActionError(null); }}>
          {t.reconciliation.linkManually}
        </Button>
      ),
    },
  ];

  const unpaidCols: Array<Column<UnpaidSubscription>> = [
    { key: 'order', header: t.subscriptions.orderId, render: (r) => <Mono value={r.order_id} /> },
    { key: 'student', header: t.subscriptions.student, render: (r) => r.student_name ?? <span className="text-ink-faint">—</span> },
    { key: 'course', header: t.subscriptions.course, render: (r) => r.course_name ?? <span className="text-ink-faint">—</span> },
    {
      key: 'amount',
      header: t.subscriptions.amount,
      numeric: true,
      render: (r) => r.amount === null ? <span className="text-ink-faint">—</span> : formatMoney(r.amount, locale),
    },
    { key: 'date', header: t.subscriptions.paymentDate, render: (r) => <span className="text-xs text-ink-muted">{formatDateTime(r.created_at, locale)}</span> },
  ];

  const unmatchedRows = unmatched.data ?? [];
  const unpaidRows = unpaid.data ?? [];
  const unmatchedTotal = unmatchedRows.reduce((s, r) => s + Number(r.signed_amount ?? 0), 0);

  return (
    <>
      <PageHeader eyebrow={t.navGroups.ops} title={t.reconciliation.title} subtitle={t.reconciliation.subtitle} />

      <section className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard
          label={t.kpi.unmatched}
          value={unmatchedRows.length}
          hint={formatMoney(unmatchedTotal, locale)}
          tone={unmatchedRows.length > 0 ? 'warn' : 'ok'}
        />
        <StatCard
          label={t.kpi.unpaid}
          value={unpaidRows.length}
          tone={unpaidRows.length > 0 ? 'warn' : 'ok'}
        />
      </section>

      {linking && (
        <Card className="mb-4">
          <CardHeader title={t.reconciliation.linkManually} />
          <div className="grid gap-3 p-4 sm:grid-cols-3">
            <Field label={t.reconciliation.pickSubscription}>
              <Select value={pickedSubscription} onChange={(e) => setPickedSubscription(e.target.value)}>
                <option value="">{t.common.none}</option>
                {unpaidRows.map((s) => (
                  <option key={s.id ?? ''} value={s.id ?? ''}>
                    {s.order_id} — {s.student_name ?? '—'}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t.reconciliation.reason}>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="flex items-end gap-2">
              <Button onClick={() => link(linking)} disabled={!pickedSubscription}>{t.common.save}</Button>
              <Button variant="ghost" onClick={() => setLinking(null)}>{t.common.cancel}</Button>
            </div>
            {actionError && <p className="text-xs text-danger sm:col-span-3">{actionError}</p>}
          </div>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title={t.reconciliation.unmatchedTitle} hint={t.reconciliation.unmatchedHint} />
          <DataTable
            columns={unmatchedCols}
            rows={unmatchedRows}
            keyOf={(r, i) => r.id ?? String(i)}
            loading={unmatched.loading}
            error={unmatched.error}
            emptyMessage={t.common.empty}
            loadingMessage={t.common.loading}
            errorMessage={t.common.error}
          />
        </Card>

        <Card>
          <CardHeader title={t.reconciliation.unpaidTitle} hint={t.reconciliation.unpaidHint} />
          <DataTable
            columns={unpaidCols}
            rows={unpaidRows}
            keyOf={(r, i) => r.id ?? String(i)}
            loading={unpaid.loading}
            error={unpaid.error}
            emptyMessage={t.common.empty}
            loadingMessage={t.common.loading}
            errorMessage={t.common.error}
          />
        </Card>
      </div>
    </>
  );
}
