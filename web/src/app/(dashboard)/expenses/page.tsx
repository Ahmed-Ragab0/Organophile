'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { createClient } from '@/lib/supabase/client';
import { downloadCsv, formatDate, formatMoney, toCsv } from '@/lib/format';
import Link from 'next/link';
import {
  Badge, Button, Card, CardHeader, Field, Input, Notice, PageHeader, Select,
} from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/table';
import { Money, StatCard } from '@/components/domain';
import { AddExpenseModal } from '@/components/financial-actions';
import { LedgerDetailModal } from '@/components/ledger-detail';
import {
  EXPENSE_CATEGORIES,
  type DashboardKpis, type ExpenseByCategory, type LedgerEntry, type WalletBalance,
} from '@/types/database';

export default function ExpensesPage() {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<LedgerEntry | null>(null);

  const [category, setCategory] = useState('');
  const [walletId, setWalletId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  /**
   * A voided expense used to be invisible here — the query filtered it out and
   * nothing offered it back. That contradicts the reason this page voids
   * instead of deleting: an expense recorded and then reversed is a different
   * fact from one that never existed, and it can only be a different fact if
   * you can still see it. It stays out of the total either way.
   */
  const [includeVoided, setIncludeVoided] = useState(false);

  const wallets = useSupabaseQuery<WalletBalance[]>(
    (sb) => sb.from('v_wallet_balances').select('*').order('sort_order'),
    [],
  );

  const { data, loading, error, reload } = useSupabaseQuery<LedgerEntry[]>(
    (sb) => {
      let q = sb
        .from('v_ledger')
        .select('*')
        .eq('entry_type', 'expense')
        .eq('is_test', false)
        .order('occurred_at', { ascending: false })
        .limit(500);

      if (!includeVoided) q = q.is('voided_at', null);
      if (category) q = q.eq('category', category);
      if (walletId) q = q.eq('wallet_id', walletId);
      if (from) q = q.gte('occurred_at', `${from}T00:00:00Z`);
      if (to) q = q.lte('occurred_at', `${to}T23:59:59Z`);
      return q;
    },
    [category, walletId, from, to, includeVoided],
  );

  // Gateway fees are no longer expenses, but they are still money out of the
  // business and the page that answers "what is this costing me" should not
  // pretend they vanished. Shown here as a figure with a pointer, never as a
  // row in the total.
  const kpis = useSupabaseQuery<DashboardKpis>(
    (sb) => sb.from('v_dashboard_kpis').select('*').single(),
    [],
  );

  const byCategory = useSupabaseQuery<ExpenseByCategory[]>(
    (sb) => sb.from('v_expenses_by_category').select('*').order('total', { ascending: false }),
    [],
  );

  const rows = data ?? [];
  const voidedRows = rows.filter((r) => r.voided_at !== null);
  // Totalled over the filtered set, so the figure always matches the table the
  // user is actually looking at — minus the voided ones, which are shown but
  // never counted. That is the whole difference between voiding and deleting.
  const total = rows
    .filter((r) => r.voided_at === null)
    .reduce((s, r) => s + Number(r.amount ?? 0), 0);

  async function voidEntry(id: string) {
    if (!window.confirm(t.ledger.confirmVoid)) return;
    const { error: err } = await createClient().rpc('void_ledger_entry', {
      p_entry_id: id, p_reason: null,
    });
    if (err) { window.alert(err.message); return; }
    reload();
    wallets.reload();
  }

  const columns: Array<Column<LedgerEntry>> = [
    {
      key: 'date',
      header: t.expenses.spentAt,
      render: (r) => (
        <span className="text-xs whitespace-nowrap text-ink-muted">
          {formatDate(r.occurred_at, locale)}
        </span>
      ),
    },
    {
      key: 'description',
      header: t.ledger.description,
      render: (r) => <span className="font-medium text-ink">{r.description ?? '—'}</span>,
    },
    {
      key: 'category',
      header: t.expenses.category,
      render: (r) => r.category ? <Badge tone="brand">{r.category}</Badge> : <span className="text-ink-faint">—</span>,
    },
    { key: 'wallet', header: t.ledger.wallet, render: (r) => r.wallet_name },
    {
      key: 'amount',
      header: t.expenses.amount,
      numeric: true,
      render: (r) => (
        <span className={r.voided_at ? 'line-through opacity-60' : undefined}>
          <Money value={Number(r.amount ?? 0)} tone={r.voided_at ? 'plain' : 'danger'} />
        </span>
      ),
    },
    {
      key: 'state',
      header: '',
      render: (r) => (r.voided_at ? <Badge tone="danger">{t.ledger.voided}</Badge> : null),
    },
    {
      key: 'notes',
      header: t.expenses.note,
      render: (r) => {
        const notes = (r.metadata as { notes?: string } | null)?.notes;
        return notes ? <span className="text-xs text-ink-muted">{notes}</span> : <span className="text-ink-faint">—</span>;
      },
    },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <div className="flex items-center justify-end gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => setDetail(r)}>
            {t.records.view}
          </Button>
          {/* Void, not delete: the ledger is append-only, and an expense that
              was recorded and then reversed is a different fact from one that
              never existed. Already voided is not voidable again. */}
          {!r.voided_at && (
            <Button size="sm" variant="ghost" onClick={() => voidEntry(r.id)}>
              {t.ledger.voidAction}
            </Button>
          )}
        </div>
      ),
    },
  ];

  const currentMonthCategories = (byCategory.data ?? []).slice(0, 6);

  return (
    <>
      <PageHeader
        eyebrow={t.navGroups.money}
        title={t.expenses.title}
        subtitle={t.expenses.subtitle}
        action={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() =>
                downloadCsv(
                  `expenses-${new Date().toISOString().slice(0, 10)}.csv`,
                  toCsv(rows as unknown as Array<Record<string, unknown>>, [
                    'occurred_at', 'description', 'category', 'wallet_name', 'amount',
                    'voided_at',
                  ]),
                )}
            >
              {t.common.export}
            </Button>
            <Button onClick={() => setOpen(true)}>+ {t.expenses.addTitle}</Button>
          </div>
        }
      />

      {Number(kpis.data?.gateway_fees ?? 0) > 0 && (
        <div className="mb-4">
          <Notice tone="info">
            {t.finance.gatewayFees}: <strong className="tnum">
              {formatMoney(Number(kpis.data?.gateway_fees ?? 0), locale)}
            </strong>
            {' — '}{t.finance.feesNotExpense}{'. '}
            <Link href="/payouts" className="font-medium text-accent-strong hover:underline">
              {t.common.view} →
            </Link>
          </Notice>
        </div>
      )}

      <section className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={t.common.total}
          value={formatMoney(total, locale)}
          hint={voidedRows.length > 0
            ? `${t.expenses.voidedExcluded} ${formatMoney(
                voidedRows.reduce((s, r) => s + Number(r.amount ?? 0), 0), locale)}`
            : undefined}
          tone="danger"
          emphasis
        />
        {currentMonthCategories.slice(0, 3).map((c) => (
          <StatCard
            key={`${c.month}-${c.category}`}
            label={c.category}
            value={formatMoney(Number(c.total ?? 0), locale)}
            hint={`${c.entries} ${t.common.rows}`}
          />
        ))}
      </section>

      <Card className="mb-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t.expenses.category}>
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{t.common.all}</option>
              {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label={t.ledger.wallet}>
            <Select value={walletId} onChange={(e) => setWalletId(e.target.value)}>
              <option value="">{t.common.all}</option>
              {(wallets.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </Field>
          <Field label={t.common.from}>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={t.common.to}>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <div className="mt-3">
          <label className="flex items-center gap-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={includeVoided}
              onChange={(e) => setIncludeVoided(e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            {t.expenses.showVoided}
          </label>
        </div>
      </Card>

      <Card>
        <CardHeader title={t.expenses.title} hint={`${rows.length} ${t.common.rows}`} />
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

      <AddExpenseModal
        open={open}
        onClose={() => setOpen(false)}
        wallets={wallets.data ?? []}
        onSaved={() => { reload(); wallets.reload(); byCategory.reload(); }}
      />

      <LedgerDetailModal entry={detail} onClose={() => setDetail(null)} />
    </>
  );
}
