'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { useMode } from '@/lib/mode/context';
import { createClient } from '@/lib/supabase/client';
import { downloadCsv, formatDateTime, toCsv } from '@/lib/format';
import {
  Badge, Button, Card, CardHeader, Field, Input, PageHeader, Select,
} from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/table';
import { LedgerTypeBadge, Mono, SignedMoney } from '@/components/domain';
import type { LedgerEntry, LedgerEntryType, WalletBalance } from '@/types/database';

const PAGE_SIZE = 100;

const TYPES: LedgerEntryType[] = [
  'revenue', 'expense', 'transfer_in', 'transfer_out',
  'refund', 'reversal', 'adjustment_in', 'adjustment_out',
];

export default function LedgerPage() {
  const { t, locale } = useI18n();
  const { isTest } = useMode();

  const [type, setType] = useState('');
  const [walletId, setWalletId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [includeVoided, setIncludeVoided] = useState(false);
  const [page, setPage] = useState(0);

  const wallets = useSupabaseQuery<WalletBalance[]>(
    (sb) => sb.from('v_wallet_balances').select('*').order('sort_order'),
    [],
  );

  const { data, loading, error, reload } = useSupabaseQuery<LedgerEntry[]>(
    (sb) => {
      let q = sb
        .from('v_ledger')
        .select('*')
        .order('occurred_at', { ascending: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
        .eq('is_test', isTest);

      if (type) q = q.eq('entry_type', type);
      if (walletId) q = q.eq('wallet_id', walletId);
      if (from) q = q.gte('occurred_at', `${from}T00:00:00Z`);
      if (to) q = q.lte('occurred_at', `${to}T23:59:59Z`);
      if (!includeVoided) q = q.is('voided_at', null);
      if (search.trim()) {
        const s = search.trim();
        q = q.or(`description.ilike.%${s}%,reference.ilike.%${s}%,student_name.ilike.%${s}%`);
      }
      return q;
    },
    [type, walletId, from, to, search, includeVoided, page, isTest],
  );

  const rows = data ?? [];

  async function voidEntry(id: string) {
    if (!window.confirm(t.ledger.confirmVoid)) return;
    const reason = window.prompt(t.ledger.voidReason) ?? null;
    const { error: err } = await createClient().rpc('void_ledger_entry', {
      p_entry_id: id,
      p_reason: reason,
    });
    if (err) {
      window.alert(err.message);
      return;
    }
    reload();
  }

  const columns: Array<Column<LedgerEntry>> = [
    {
      key: 'date',
      header: t.ledger.date,
      render: (r) => (
        <span className="text-xs whitespace-nowrap text-ink-muted">
          {formatDateTime(r.occurred_at, locale)}
        </span>
      ),
    },
    { key: 'type', header: t.ledger.type, render: (r) => <LedgerTypeBadge type={r.entry_type} /> },
    {
      key: 'description',
      header: t.ledger.description,
      render: (r) => (
        <div className="min-w-0">
          <p className="truncate text-ink">{r.description ?? '—'}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            {r.category && <span className="text-xs text-ink-faint">{r.category}</span>}
            {r.is_test && <Badge tone="warn">{t.common.test}</Badge>}
            {r.voided_at && <Badge tone="danger">{t.ledger.voided}</Badge>}
          </div>
        </div>
      ),
    },
    { key: 'wallet', header: t.ledger.wallet, render: (r) => r.wallet_name },
    {
      key: 'student',
      header: t.ledger.student,
      render: (r) =>
        r.student_id
          ? (
            <Link href={`/students/${r.student_id}`} className="text-accent-strong hover:underline">
              {r.student_name}
            </Link>
          )
          : <span className="text-ink-faint">—</span>,
    },
    {
      key: 'effect',
      header: t.ledger.effect,
      numeric: true,
      // The wallet delta, not the raw amount: a transfer out of a wallet reads
      // as negative even though the stored amount is positive.
      render: (r) => <SignedMoney value={Number(r.wallet_delta ?? 0)} />,
    },
    { key: 'reference', header: t.ledger.reference, render: (r) => <Mono value={r.reference} /> },
    {
      key: 'actions',
      header: '',
      render: (r) =>
        r.voided_at
          ? <span className="text-xs text-ink-faint">{t.ledger.voided}</span>
          : (
            <Button size="sm" variant="danger" onClick={() => voidEntry(r.id)}>
              {t.ledger.voidAction}
            </Button>
          ),
    },
  ];

  function resetPageAnd(setter: (v: string) => void) {
    return (v: string) => { setPage(0); setter(v); };
  }

  return (
    <>
      <PageHeader
        eyebrow={t.navGroups.money}
        title={t.ledger.title}
        subtitle={t.ledger.subtitle}
        action={
          <Button
            variant="secondary"
            onClick={() =>
              downloadCsv(
                `ledger-${new Date().toISOString().slice(0, 10)}.csv`,
                toCsv(rows as unknown as Array<Record<string, unknown>>, [
                  'occurred_at', 'entry_type', 'amount', 'wallet_delta', 'wallet_name',
                  'description', 'category', 'student_name', 'course_name',
                  'reference', 'is_test', 'voided_at',
                ]),
              )}
          >
            {t.common.export}
          </Button>
        }
      />

      <Card className="mb-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label={t.common.search}>
            <Input value={search} onChange={(e) => resetPageAnd(setSearch)(e.target.value)} />
          </Field>
          <Field label={t.ledger.type}>
            <Select value={type} onChange={(e) => resetPageAnd(setType)(e.target.value)}>
              <option value="">{t.common.all}</option>
              {TYPES.map((ty) => <option key={ty} value={ty}>{t.ledger.types[ty]}</option>)}
            </Select>
          </Field>
          <Field label={t.ledger.wallet}>
            <Select value={walletId} onChange={(e) => resetPageAnd(setWalletId)(e.target.value)}>
              <option value="">{t.common.all}</option>
              {(wallets.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </Select>
          </Field>
          <Field label={t.common.from}>
            <Input type="date" value={from} onChange={(e) => resetPageAnd(setFrom)(e.target.value)} />
          </Field>
          <Field label={t.common.to}>
            <Input type="date" value={to} onChange={(e) => resetPageAnd(setTo)(e.target.value)} />
          </Field>
        </div>
        <label className="mt-3 flex items-center gap-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={includeVoided}
            onChange={(e) => { setPage(0); setIncludeVoided(e.target.checked); }}
            className="accent-[var(--color-accent)]"
          />
          {t.ledger.voided}
        </label>
      </Card>

      <Card>
        <CardHeader
          title={t.ledger.title}
          hint={`${rows.length} ${t.common.rows}`}
          action={
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                {t.common.prev}
              </Button>
              <span className="text-xs tnum text-ink-muted">{page + 1}</span>
              <Button
                size="sm" variant="secondary"
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
          keyOf={(r) => r.id}
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
