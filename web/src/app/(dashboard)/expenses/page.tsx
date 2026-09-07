'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { createClient } from '@/lib/supabase/client';
import { downloadCsv, formatDate, formatMoney, toCsv, toCairoDateKey } from '@/lib/format';
import { Button, Card, CardHeader, Field, Input, PageHeader } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/table';
import { StatCard } from '@/components/domain';
import type { Expense } from '@/types/database';

export default function ExpensesPage() {
  const { t, locale } = useI18n();

  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [spentAt, setSpentAt] = useState(() => toCairoDateKey(new Date()));
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const { data, loading, error, reload } = useSupabaseQuery<Expense[]>(
    (sb) => sb.from('expenses').select('*').order('spent_at', { ascending: false }).limit(500),
    [],
  );

  const rows = data ?? [];
  const total = rows.reduce((sum, r) => sum + Number(r.amount ?? 0), 0);

  async function addExpense(e: React.FormEvent) {
    e.preventDefault();
    const value = Number(amount);
    if (!category.trim() || !Number.isFinite(value) || value < 0) return;

    setBusy(true);
    setFormError(null);

    const supabase = createClient();
    const { data: auth } = await supabase.auth.getUser();
    const { error: insertError } = await supabase.from('expenses').insert({
      category: category.trim(),
      amount: value,
      note: note.trim() || null,
      spent_at: spentAt,
      created_by: auth.user?.id ?? null,
    });

    setBusy(false);
    if (insertError) {
      setFormError(insertError.message);
      return;
    }
    setCategory('');
    setAmount('');
    setNote('');
    reload();
  }

  async function remove(id: string) {
    if (!window.confirm(t.expenses.confirmDelete)) return;
    const { error: deleteError } = await createClient().from('expenses').delete().eq('id', id);
    if (deleteError) {
      setFormError(deleteError.message);
      return;
    }
    reload();
  }

  const columns: Array<Column<Expense>> = [
    { key: 'date', header: t.expenses.spentAt, render: (r) => <span className="text-xs text-ink-muted">{formatDate(r.spent_at, locale)}</span> },
    { key: 'category', header: t.expenses.category, render: (r) => <span className="font-medium text-ink">{r.category}</span> },
    { key: 'amount', header: t.expenses.amount, numeric: true, render: (r) => formatMoney(r.amount, locale) },
    { key: 'note', header: t.expenses.note, render: (r) => r.note ?? <span className="text-ink-faint">—</span> },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <Button size="sm" variant="danger" onClick={() => remove(r.id)}>{t.common.delete}</Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t.expenses.title}
        subtitle={t.expenses.subtitle}
        action={
          <Button
            variant="secondary"
            onClick={() =>
              downloadCsv(
                `expenses-${new Date().toISOString().slice(0, 10)}.csv`,
                toCsv(rows, ['spent_at', 'category', 'amount', 'currency', 'note']),
              )}
          >
            {t.common.export}
          </Button>
        }
      />

      <section className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t.common.total} value={formatMoney(total, locale)} tone="danger" />
      </section>

      <Card className="mb-4">
        <CardHeader title={t.expenses.addTitle} />
        <form onSubmit={addExpense} className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
          <Field label={t.expenses.category}>
            <Input value={category} onChange={(e) => setCategory(e.target.value)} required />
          </Field>
          <Field label={t.expenses.amount}>
            <Input
              type="number" min="0" step="0.01" inputMode="decimal"
              value={amount} onChange={(e) => setAmount(e.target.value)} required dir="ltr"
            />
          </Field>
          <Field label={t.expenses.spentAt}>
            <Input type="date" value={spentAt} onChange={(e) => setSpentAt(e.target.value)} required />
          </Field>
          <Field label={t.expenses.note}>
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button type="submit" disabled={busy}>{t.common.add}</Button>
          </div>
          {formError && <p className="text-xs text-danger sm:col-span-2 lg:col-span-5">{formError}</p>}
        </form>
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
    </>
  );
}
