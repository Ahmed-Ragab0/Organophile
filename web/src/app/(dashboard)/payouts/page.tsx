'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useMode } from '@/lib/mode/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { createClient } from '@/lib/supabase/client';
import { formatDateTime, formatMoney } from '@/lib/format';
import {
  Badge, Button, Card, CardHeader, Notice, PageHeader,
} from '@/components/ui/primitives';
import { IconRefresh } from '@/components/ui/icons';
import { FeeSchedulePanel } from '@/components/fee-schedule';
import { DataTable, type Column } from '@/components/ui/table';
import { ModeBadge, Money, Mono, StatCard, TransferBadge } from '@/components/domain';
import { MoneyPositionPanel } from '@/components/money-position';
import type { MoneyPosition, Payout } from '@/types/database';

/**
 * "Did Kashier actually pay me?"
 *
 * Deliberately not answered from webhooks: this account's transfer webhooks
 * arrive with no signature at all and are refused. The authoritative source is
 * a GET we make ourselves against Kashier's Payout API with our own Secret
 * Key, which is better provenance than an unsigned inbound POST anyway.
 *
 * So this page has two halves. The top is OUR arithmetic — what we were paid,
 * minus fees, minus what has been transferred out. The bottom is KASHIER'S
 * answer to the same question. A gap between them is the signal that something
 * was missed, which is why both are shown rather than one.
 */
export default function PayoutsPage() {
  const { t, locale } = useI18n();
  const { mode } = useMode();
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'danger' | 'warn'; text: string } | null>(null);

  const position = useSupabaseQuery<MoneyPosition>(
    (sb) => sb.from('v_money_position').select('*').eq('mode', mode).single(),
    [mode, result],
  );

  const list = useSupabaseQuery<Payout[]>(
    (sb) =>
      sb.from('payouts').select('*')
        .eq('mode', mode)
        .order('transfer_date', { ascending: false, nullsFirst: false })
        .limit(300),
    [mode, result],
  );

  async function sync() {
    setSyncing(true);
    setResult(null);
    try {
      // The sync endpoint authorises the caller itself: it accepts an admin's
      // JWT or the service key, never the anon key.
      const { data: session } = await createClient().auth.getSession();
      const token = session.session?.access_token;
      if (!token) throw new Error('no session');

      const res = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/kashier-sync-payouts?mode=${mode}`,
        { method: 'POST', headers: { authorization: `Bearer ${token}` } },
      );
      const body = await res.json().catch(() => null);

      if (res.ok) {
        const s = body as { fetched?: number; ingested?: number; duplicates?: number } | null;
        setResult({
          tone: 'ok',
          text: `${t.payouts.syncDone} — ${t.payouts.syncFetched}: ${s?.fetched ?? 0} · ${t.payouts.syncNew}: ${s?.ingested ?? 0}`,
        });
        return;
      }

      // The one failure worth naming precisely: the Merchant Secret Key for
      // this mode is not in Supabase, so no call to Kashier was even made.
      const code = (body as { error?: string } | null)?.error;
      if (code === 'no_secret_key_for_mode') {
        setResult({ tone: 'warn', text: t.payouts.missingSecret.replace('{mode}', mode) });
        return;
      }
      setResult({ tone: 'danger', text: `${res.status}: ${code ?? JSON.stringify(body)}` });
    } catch (err) {
      setResult({ tone: 'danger', text: String(err) });
    } finally {
      setSyncing(false);
    }
  }

  const rows = list.data ?? [];
  const p = position.data;
  const n = (v: number | null | undefined) => Number(v ?? 0);

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
        eyebrow={t.navGroups.ops}
        title={t.payouts.title}
        subtitle={t.payouts.subtitle}
        action={
          <Button onClick={sync} disabled={syncing}>
            <IconRefresh className={syncing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            {syncing ? t.payouts.syncing : t.finance.syncNow}
          </Button>
        }
      />

      {result && (
        <div className="mb-5">
          <Notice tone={result.tone}>{result.text}</Notice>
        </div>
      )}

      {/* The position and the one number in it that comes from us rather than
          from Kashier, side by side — so the deduction and its source are
          read together. */}
      <div className="mb-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <MoneyPositionPanel position={p} loading={position.loading} />
        <FeeSchedulePanel mode={mode} kashierReports={p?.kashier_payout_fees} />
      </div>

      <section className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={t.payouts.transferred}
          value={formatMoney(n(p?.transferred), locale)}
          hint={`${n(p?.transfers_count)} ${t.position.transfersCount}`}
          tone="ok"
        />
        <StatCard
          label={t.finance.payoutsInFlight}
          value={formatMoney(n(p?.in_flight), locale)}
          tone={n(p?.in_flight) > 0 ? 'warn' : 'neutral'}
        />
        <StatCard
          label={t.position.awaiting}
          value={formatMoney(n(p?.awaiting_payout), locale)}
          hint={t.position.awaitingHint}
          tone={n(p?.awaiting_payout) > 0 ? 'warn' : 'neutral'}
          emphasis
        />
        <StatCard
          label={t.payouts.failed}
          value={formatMoney(n(p?.failed), locale)}
          tone={n(p?.failed) > 0 ? 'danger' : 'neutral'}
        />
      </section>

      <Card>
        <CardHeader
          title={t.payouts.title}
          hint={`${rows.length} ${t.common.rows}`}
          action={<Badge tone={mode === 'test' ? 'warn' : 'ok'}>{t.mode[mode]}</Badge>}
        />
        <DataTable
          columns={columns}
          rows={rows}
          keyOf={(r) => r.id}
          loading={list.loading}
          error={list.error}
          emptyMessage={t.mode.emptyForMode}
          loadingMessage={t.common.loading}
          errorMessage={t.common.error}
        />
      </Card>
    </>
  );
}
