'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { createClient } from '@/lib/supabase/client';
import { formatDateTime, formatMoney } from '@/lib/format';
import {
  Badge, Button, Card, CardHeader, PageHeader,
} from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/table';
import { ModeBadge, Money, Mono, StatCard, TransferBadge } from '@/components/domain';
import type { KashierAccount, Payout, PayoutSummary } from '@/types/database';

const SYNC_URL = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/kashier-sync-payouts?mode=live`;

/**
 * "Did Kashier actually pay me?" is answered here, and deliberately not from
 * webhooks alone: this account's transfer webhooks arrive unsigned and are
 * refused, so the authoritative source is a GET we make ourselves against
 * Kashier's Payout API with our own Secret Key.
 */
export default function PayoutsPage() {
  const { t, locale } = useI18n();
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const account = useSupabaseQuery<KashierAccount[]>(
    (sb) => sb.from('kashier_account').select('*').eq('mode', 'live'),
    [syncResult],
  );

  const summary = useSupabaseQuery<PayoutSummary[]>(
    (sb) => sb.from('v_payout_summary').select('*').eq('mode', 'live'),
    [syncResult],
  );

  const list = useSupabaseQuery<Payout[]>(
    (sb) =>
      sb.from('payouts').select('*')
        .order('transfer_date', { ascending: false, nullsFirst: false })
        .limit(300),
    [syncResult],
  );

  async function sync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      // The sync endpoint authorises the caller itself: it accepts an admin's
      // JWT or the service key, never the anon key.
      const { data: session } = await createClient().auth.getSession();
      const token = session.session?.access_token;
      if (!token) throw new Error('no session');

      const res = await fetch(SYNC_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      setSyncResult(res.ok ? JSON.stringify(body) : `${res.status}: ${JSON.stringify(body)}`);
    } catch (err) {
      setSyncResult(String(err));
    } finally {
      setSyncing(false);
    }
  }

  const rows = list.data ?? [];
  const acct = (account.data ?? [])[0];
  const totalFor = (event: string) =>
    Number((summary.data ?? []).find((s) => s.event === event)?.total_amount ?? 0);

  const inFlight =
    totalFor('INITIATED') + totalFor('IN_TRANSIT') + totalFor('PARTIALLY_TRANSFERRED');

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
      render: (r) => <Money value={Number(r.amount ?? 0)} tone="plain" />,
    },
    {
      key: 'recipient',
      header: t.payouts.recipient,
      render: (r) =>
        r.recipient_name || r.recipient_number
          ? (
            <div className="min-w-0">
              {r.recipient_name && <p className="truncate text-ink">{r.recipient_name}</p>}
              {r.recipient_number && (
                <p className="ltr-id truncate text-ink-faint">{r.recipient_number}</p>
              )}
            </div>
          )
          : <span className="text-ink-faint">—</span>,
    },
    {
      key: 'method',
      header: t.payouts.method,
      render: (r) => r.method
        ? <Badge tone="info">{r.method}</Badge>
        : <span className="text-ink-faint">—</span>,
    },
    {
      key: 'ref',
      header: t.payouts.reference,
      render: (r) => <Mono value={r.merchant_transfer_id ?? r.reference} />,
    },
  ];

  return (
    <>
      <PageHeader
        title={t.payouts.title}
        subtitle={t.payouts.subtitle}
        action={
          <Button onClick={sync} disabled={syncing}>
            {syncing ? t.common.loading : t.finance.syncNow}
          </Button>
        }
      />

      {syncResult && (
        <p className="mb-4 rounded-[--radius-field] bg-info-soft px-3 py-2 text-xs break-all text-info">
          <span className="ltr-id">{syncResult}</span>
        </p>
      )}

      <section className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={t.finance.availableBalance}
          value={formatMoney(Number(acct?.available_balance ?? 0), locale)}
          hint={
            acct?.synced_at
              ? `${t.finance.syncedAt}: ${formatDateTime(acct.synced_at, locale)}`
              : t.finance.neverSynced
          }
          emphasis
        />
        <StatCard
          label={t.payouts.transferred}
          value={formatMoney(totalFor('TRANSFERRED'), locale)}
          tone="ok"
        />
        <StatCard
          label={t.finance.payoutsInFlight}
          value={formatMoney(inFlight, locale)}
          tone={inFlight > 0 ? 'warn' : 'neutral'}
        />
        <StatCard
          label={t.payouts.failed}
          value={formatMoney(totalFor('FAILED'), locale)}
          tone={totalFor('FAILED') > 0 ? 'danger' : 'neutral'}
        />
      </section>

      {acct && (
        <Card className="mb-4">
          <CardHeader title={t.finance.kashierBalance} hint={acct.merchant_name ?? undefined} />
          <dl className="grid gap-4 p-5 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-ink-muted">{t.finance.availableBalance}</dt>
              <dd className="mt-1 font-display text-lg font-semibold tnum text-ink">
                {formatMoney(Number(acct.available_balance ?? 0), locale)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">{t.finance.lastTransfer}</dt>
              <dd className="mt-1 font-display text-lg font-semibold tnum text-ink">
                {formatMoney(Number(acct.last_transfer ?? 0), locale)}
              </dd>
              {acct.last_transfer_date && (
                <p className="text-xs text-ink-faint">
                  {formatDateTime(acct.last_transfer_date, locale)}
                </p>
              )}
            </div>
            <div>
              <dt className="text-xs text-ink-muted">{t.payouts.method}</dt>
              <dd className="mt-1 text-sm text-ink">{acct.payout_method ?? '—'}</dd>
            </div>
          </dl>
        </Card>
      )}

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
