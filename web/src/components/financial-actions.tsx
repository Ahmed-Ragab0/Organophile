'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useI18n } from '@/lib/i18n/context';
import { toCairoDateKey } from '@/lib/format';
import {
  Button, Checkbox, Field, Input, Modal, Notice, Select, Textarea,
} from './ui/primitives';
import { EXPENSE_CATEGORIES, type WalletBalance } from '@/types/database';

/**
 * Every one of these calls a database function rather than inserting directly.
 * RLS denies direct writes to ledger_entries, so the invariants — positive
 * amounts, balanced transfers, real wallets — cannot be bypassed from here,
 * and the error the user sees is the database's own rule, not a duplicate of
 * it written in TypeScript.
 */

function useLedgerAction(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // PromiseLike, not Promise: PostgREST returns a thenable query builder.
  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    setError(null);
    const { error: err } = await fn();
    setBusy(false);
    if (err) {
      setError(err.message);
      return false;
    }
    onDone();
    return true;
  }

  return { busy, error, setError, run };
}

export function AddExpenseModal({
  open, onClose, wallets, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  wallets: WalletBalance[];
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<string>(EXPENSE_CATEGORIES[0]);
  const [amount, setAmount] = useState('');
  const [walletId, setWalletId] = useState('');
  const [date, setDate] = useState(() => toCairoDateKey(new Date()));
  const [notes, setNotes] = useState('');

  const { busy, error, setError, run } = useLedgerAction(() => {
    setDescription(''); setAmount(''); setNotes('');
    onSaved();
    onClose();
  });

  const active = wallets.filter((w) => w.is_active);
  const effectiveWallet = walletId || active[0]?.id || '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!effectiveWallet) {
      setError(t.wallets.title);
      return;
    }
    await run(() =>
      createClient().rpc('add_expense', {
        p_description: description,
        p_category: category,
        p_amount: Number(amount),
        p_wallet_id: effectiveWallet,
        p_occurred_at: new Date(`${date}T12:00:00`).toISOString(),
        p_notes: notes || null,
      }),
    );
  }

  return (
    <Modal open={open} onClose={onClose} title={t.expenses.addTitle}>
      <form id="expense-form" onSubmit={submit} className="space-y-3">
        <Field label={`${t.ledger.description} *`}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} required />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`${t.expenses.category} *`}>
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label={`${t.expenses.amount} *`}>
            <Input
              type="number" min="0.01" step="0.01" inputMode="decimal" dir="ltr"
              value={amount} onChange={(e) => setAmount(e.target.value)} required
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`${t.ledger.wallet} *`}>
            <Select value={effectiveWallet} onChange={(e) => setWalletId(e.target.value)} required>
              {active.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </Field>
          <Field label={t.expenses.spentAt}>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>

        <Field label={`${t.expenses.note} (${t.common.optional})`}>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        {error && <Notice tone="danger">{error}</Notice>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button type="submit" disabled={busy}>{busy ? t.common.saving : t.common.save}</Button>
        </div>
      </form>
    </Modal>
  );
}

export function TransferModal({
  open, onClose, wallets, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  wallets: WalletBalance[];
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const active = wallets.filter((w) => w.is_active);

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => toCairoDateKey(new Date()));
  const [notes, setNotes] = useState('');
  const [overdraft, setOverdraft] = useState(false);

  const { busy, error, run } = useLedgerAction(() => {
    setAmount(''); setNotes('');
    onSaved();
    onClose();
  });

  const fromId = from || active[0]?.id || '';
  const toId = to || active.find((w) => w.id !== fromId)?.id || '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await run(() =>
      createClient().rpc('transfer_between_wallets', {
        p_from_wallet_id: fromId,
        p_to_wallet_id: toId,
        p_amount: Number(amount),
        p_occurred_at: new Date(`${date}T12:00:00`).toISOString(),
        p_notes: notes || null,
        p_allow_overdraft: overdraft,
      }),
    );
  }

  return (
    <Modal open={open} onClose={onClose} title={t.transfer.title}>
      <form onSubmit={submit} className="space-y-3">
        {/* Stated up front, because treating a transfer as income is the
            single easiest way to misread your own books. */}
        <Notice tone="info">{t.transfer.note}</Notice>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`${t.transfer.from} *`}>
            <Select value={fromId} onChange={(e) => setFrom(e.target.value)} required>
              {active.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </Field>
          <Field label={`${t.transfer.to} *`}>
            <Select value={toId} onChange={(e) => setTo(e.target.value)} required>
              {active.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`${t.transfer.amount} *`}>
            <Input
              type="number" min="0.01" step="0.01" inputMode="decimal" dir="ltr"
              value={amount} onChange={(e) => setAmount(e.target.value)} required
            />
          </Field>
          <Field label={t.transfer.date}>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>

        <Field label={`${t.transfer.notes} (${t.common.optional})`}>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <Checkbox
          checked={overdraft}
          onChange={setOverdraft}
          label={t.transfer.allowOverdraft}
        />

        {error && <Notice tone="danger">{error}</Notice>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button type="submit" variant="accent" disabled={busy}>
            {busy ? t.common.saving : t.transfer.submit}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function AddRevenueModal({
  open, onClose, wallets, onSaved, students,
}: {
  open: boolean;
  onClose: () => void;
  wallets: WalletBalance[];
  onSaved: () => void;
  students: Array<{ id: string; name: string }>;
}) {
  const { t } = useI18n();
  const active = wallets.filter((w) => w.is_active);

  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [walletId, setWalletId] = useState('');
  const [studentId, setStudentId] = useState('');
  const [date, setDate] = useState(() => toCairoDateKey(new Date()));
  const [notes, setNotes] = useState('');

  const { busy, error, run } = useLedgerAction(() => {
    setDescription(''); setAmount(''); setNotes(''); setStudentId('');
    onSaved();
    onClose();
  });

  const effectiveWallet = walletId || active[0]?.id || '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await run(() =>
      createClient().rpc('add_manual_revenue', {
        p_description: description,
        p_amount: Number(amount),
        p_wallet_id: effectiveWallet,
        p_student_id: studentId || null,
        p_subscription_id: null,
        p_occurred_at: new Date(`${date}T12:00:00`).toISOString(),
        p_notes: notes || null,
      }),
    );
  }

  return (
    <Modal open={open} onClose={onClose} title={t.ledger.types.revenue}>
      <form onSubmit={submit} className="space-y-3">
        <Field label={`${t.ledger.description} *`}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} required />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`${t.ledger.amount} *`}>
            <Input
              type="number" min="0.01" step="0.01" inputMode="decimal" dir="ltr"
              value={amount} onChange={(e) => setAmount(e.target.value)} required
            />
          </Field>
          <Field label={`${t.ledger.wallet} *`}>
            <Select value={effectiveWallet} onChange={(e) => setWalletId(e.target.value)} required>
              {active.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`${t.ledger.student} (${t.common.optional})`}>
            <Select value={studentId} onChange={(e) => setStudentId(e.target.value)}>
              <option value="">{t.common.none}</option>
              {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label={t.ledger.date}>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>

        <Field label={`${t.transfer.notes} (${t.common.optional})`}>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        {error && <Notice tone="danger">{error}</Notice>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button type="submit" disabled={busy}>{busy ? t.common.saving : t.common.save}</Button>
        </div>
      </form>
    </Modal>
  );
}
