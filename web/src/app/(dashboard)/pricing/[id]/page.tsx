'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { createClient } from '@/lib/supabase/client';
import { formatDate, formatDateTime, formatMoney, toCairoDateKey } from '@/lib/format';
import {
  Badge, Button, Card, CardHeader, ErrorState, Field, Input, Modal, Notice,
  PageHeader, PageSkeleton, Select, Spinner, Textarea,
} from '@/components/ui/primitives';
import { Money, Mono, PaymentStatusBadge, StatCard } from '@/components/domain';
import { effectivePrice, PriceSourceBadge } from '@/components/pricing';
import { LedgerDetailModal } from '@/components/ledger-detail';
import type {
  LedgerEntry, SubscriptionFinancials, SubscriptionInstallment, WalletBalance,
} from '@/types/database';

type SubscriptionDetail = {
  id: string;
  order_id: string;
  total_due: number | null;
  amount: number | null;
  currency: string;
  installment_count: number;
  due_date: string | null;
  notes: string | null;
  payment_date: string | null;
  source: string;
  created_at: string;
  student_id: string | null;
  students: { id: string; name: string; phone: string | null } | null;
  courses: { id: string; name: string } | null;
  packages: { id: string; name: string; price: number | null } | null;
};

/** One editable row of the collection plan. */
type DraftInstallment = { seq: number; amount: string; due_date: string };

function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  // Day 0 of the following month is the last day of the target month, which is
  // how a 31st stays inside a 30-day month instead of rolling into the next.
  const lastDay = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  const date = new Date(Date.UTC(y, m - 1 + months, Math.min(d, lastDay)));
  return date.toISOString().slice(0, 10);
}

/**
 * Split a price into `count` instalments without losing a piastre.
 *
 * Each instalment is rounded down to two decimals and the remainder is added
 * to the first one, so the schedule always sums back to the exact price. A
 * plan that quietly totals 999.99 against a 1000 price is a plan that will be
 * argued about later.
 */
function splitEvenly(total: number, count: number, firstDue: string): DraftInstallment[] {
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / count);
  const remainder = cents - base * count;
  return Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    amount: ((base + (i === 0 ? remainder : 0)) / 100).toFixed(2),
    due_date: addMonths(firstDue, i),
  }));
}

export default function SubscriptionPricingPage(
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = use(params);
  const { t, locale } = useI18n();
  const [nonce, setNonce] = useState(0);
  const reload = () => setNonce((n) => n + 1);

  const detail = useSupabaseQuery<SubscriptionDetail>(
    (sb) =>
      sb
        .from('subscriptions')
        .select(
          'id,order_id,total_due,amount,currency,installment_count,due_date,notes,' +
            'payment_date,source,created_at,student_id,' +
            'students(id,name,phone),courses(id,name),packages(id,name,price)',
        )
        .eq('id', id)
        .single() as unknown as PromiseLike<{
        data: SubscriptionDetail | null;
        error: { message: string } | null;
      }>,
    [id, nonce],
  );

  const money = useSupabaseQuery<SubscriptionFinancials>(
    (sb) => sb.from('v_subscription_financials').select('*').eq('subscription_id', id).single(),
    [id, nonce],
  );

  const installments = useSupabaseQuery<SubscriptionInstallment[]>(
    (sb) =>
      sb.from('subscription_installments').select('*').eq('subscription_id', id).order('seq'),
    [id, nonce],
  );

  const entries = useSupabaseQuery<LedgerEntry[]>(
    (sb) =>
      sb.from('v_ledger').select('*').eq('subscription_id', id)
        .order('occurred_at', { ascending: false }),
    [id, nonce],
  );

  const wallets = useSupabaseQuery<WalletBalance[]>(
    (sb) => sb.from('v_wallet_balances').select('*').order('sort_order'),
    [],
  );

  if (detail.loading) return <PageSkeleton label={t.common.loading} />;
  if (detail.error || !detail.data) {
    return <ErrorState message={t.common.error} detail={detail.error ?? undefined} />;
  }

  const sub = detail.data;
  const price = effectivePrice(sub);
  const scheduleKey = (installments.data ?? [])
    .map((r) => `${r.seq}:${r.amount}:${r.due_date ?? ''}`)
    .join('|');

  return (
    <>
      <PageHeader
        eyebrow={t.pricing.title}
        title={sub.students?.name ?? sub.order_id}
        subtitle={[sub.courses?.name, sub.packages?.name].filter(Boolean).join(' · ') || undefined}
        action={
          <Link
            href="/pricing"
            className="rounded-field px-3 py-2 text-sm text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            ← {t.pricing.backToPricing}
          </Link>
        }
      />

      <section className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={t.pricing.effectivePrice}
          value={formatMoney(Number(money.data?.total_due ?? price.value), locale)}
          hint={sub.order_id}
        />
        <StatCard
          label={t.studentDetail.totalPaid}
          value={formatMoney(Number(money.data?.total_paid ?? 0), locale)}
          tone="ok"
        />
        <StatCard
          label={t.studentDetail.remaining}
          value={formatMoney(Number(money.data?.remaining ?? 0), locale)}
          tone={Number(money.data?.remaining ?? 0) > 0 ? 'danger' : 'neutral'}
          emphasis
        />
        <Card className="p-4">
          <p className="text-xs font-medium text-ink-muted">{t.studentDetail.status}</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <PaymentStatusBadge status={money.data?.payment_status} />
            <PriceSourceBadge source={price.source} />
          </div>
          <p className="mt-2 text-xs text-ink-faint">
            {money.data?.last_payment_at
              ? `${t.studentDetail.lastPayment}: ${formatDate(money.data.last_payment_at, locale)}`
              : t.common.none}
          </p>
        </Card>
      </section>

      <div className="grid gap-5 xl:grid-cols-2">
        <TermsCard subscription={sub} onSaved={reload} />
        <ScheduleCard
          // Remounting on a change to the SAVED schedule is what resets the
          // draft. Keying on the saved content means typing never resets it,
          // but a save — or a change made elsewhere — always does.
          key={scheduleKey}
          subscriptionId={id}
          price={Number(money.data?.total_due ?? price.value)}
          installmentCount={sub.installment_count}
          dueDate={sub.due_date}
          rows={installments.data ?? []}
          loading={installments.loading}
          onSaved={reload}
        />
      </div>

      <div className="mt-5">
        <PaymentsCard
          subscription={sub}
          entries={entries.data ?? []}
          loading={entries.loading}
          error={entries.error}
          wallets={(wallets.data ?? []).filter((w) => w.is_active)}
          onChanged={reload}
        />
      </div>
    </>
  );
}

/* ── price and terms ────────────────────────────────────────────────────── */

function TermsCard({
  subscription, onSaved,
}: { subscription: SubscriptionDetail; onSaved: () => void }) {
  const { t, locale } = useI18n();
  const [totalDue, setTotalDue] = useState(
    subscription.total_due === null ? '' : String(subscription.total_due),
  );
  const [dueDate, setDueDate] = useState(subscription.due_date ?? '');
  const [count, setCount] = useState(String(subscription.installment_count));
  const [notes, setNotes] = useState(subscription.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);

    const { error } = await createClient()
      .from('subscriptions')
      .update({
        // Empty means "fall back to the package price", which is a real,
        // different state from "priced at zero" — so it must be null, not 0.
        total_due: totalDue.trim() === '' ? null : Number(totalDue),
        due_date: dueDate === '' ? null : dueDate,
        installment_count: Math.max(1, Number(count) || 1),
        notes: notes.trim() === '' ? null : notes.trim(),
      })
      .eq('id', subscription.id);

    setBusy(false);
    if (error) {
      setResult({ tone: 'danger', text: error.message });
      return;
    }
    setResult({ tone: 'ok', text: t.common.saved });
    onSaved();
  }

  const packagePrice = subscription.packages?.price;

  return (
    <Card>
      <CardHeader
        title={t.pricing.terms}
        hint={subscription.order_id}
        action={<Badge tone="neutral">{subscription.source}</Badge>}
      />
      <form onSubmit={save} className="space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t.pricing.totalDue}
            hint={
              packagePrice !== null && packagePrice !== undefined
                ? `${t.pricing.totalDueHint} (${formatMoney(Number(packagePrice), locale)})`
                : t.pricing.totalDueHint
            }
          >
            <Input
              type="number" min="0" step="0.01" inputMode="decimal" dir="ltr"
              value={totalDue} placeholder="—"
              onChange={(e) => setTotalDue(e.target.value)}
            />
          </Field>
          <Field label={t.pricing.dueDate}>
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.pricing.installmentCount}>
            <Input
              type="number" min="1" max="24" step="1" dir="ltr"
              value={count} onChange={(e) => setCount(e.target.value)}
            />
          </Field>
          <Field label={t.subscriptions.paymentDate}>
            <Input
              value={
                subscription.payment_date
                  ? formatDate(subscription.payment_date, locale)
                  : formatDate(subscription.created_at, locale)
              }
              readOnly
              disabled
            />
          </Field>
        </div>

        <Field label={`${t.pricing.notes} (${t.common.optional})`}>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        {result && <Notice tone={result.tone}>{result.text}</Notice>}

        <div className="flex justify-end">
          <Button type="submit" disabled={busy}>
            {busy ? t.common.saving : t.common.save}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/* ── the collection plan ────────────────────────────────────────────────── */

function ScheduleCard({
  subscriptionId, price, installmentCount, dueDate, rows, loading, onSaved,
}: {
  subscriptionId: string;
  price: number;
  installmentCount: number;
  dueDate: string | null;
  rows: SubscriptionInstallment[];
  loading: boolean;
  onSaved: () => void;
}) {
  const { t, locale } = useI18n();
  // Seeded once per mount from the saved schedule; the parent's key remounts
  // this card whenever that saved schedule changes.
  const [draft, setDraft] = useState<DraftInstallment[]>(() =>
    rows.map((r) => ({ seq: r.seq, amount: String(r.amount), due_date: r.due_date ?? '' })),
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  const total = draft.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  const mismatch = draft.length > 0 && Math.abs(total - price) > 0.009;

  function update(index: number, patch: Partial<DraftInstallment>) {
    setDraft((d) => d.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function autoSplit() {
    const start = dueDate || toCairoDateKey(new Date());
    setDraft(splitEvenly(price, Math.max(1, installmentCount), start));
    setResult(null);
  }

  function addRow() {
    setDraft((d) => [
      ...d,
      {
        seq: d.length + 1,
        amount: '0',
        due_date: d.length > 0 && d[d.length - 1].due_date
          ? addMonths(d[d.length - 1].due_date, 1)
          : dueDate || toCairoDateKey(new Date()),
      },
    ]);
  }

  function removeRow(index: number) {
    setDraft((d) => d.filter((_, i) => i !== index).map((row, i) => ({ ...row, seq: i + 1 })));
  }

  async function save() {
    setBusy(true);
    setResult(null);
    const sb = createClient();

    if (draft.length > 0) {
      // Upsert before delete, never the other way round: a failed insert after
      // a delete would leave the plan wiped with nothing to show for it.
      const { error } = await sb.from('subscription_installments').upsert(
        draft.map((r) => ({
          subscription_id: subscriptionId,
          seq: r.seq,
          amount: Number(r.amount) || 0,
          due_date: r.due_date === '' ? null : r.due_date,
        })),
        { onConflict: 'subscription_id,seq' },
      );
      if (error) {
        setBusy(false);
        setResult({ tone: 'danger', text: error.message });
        return;
      }
    }

    const { error: pruneError } = await sb
      .from('subscription_installments')
      .delete()
      .eq('subscription_id', subscriptionId)
      .gt('seq', draft.length);

    setBusy(false);
    if (pruneError) {
      setResult({ tone: 'danger', text: pruneError.message });
      return;
    }
    setResult({ tone: 'ok', text: t.common.saved });
    onSaved();
  }

  return (
    <Card>
      <CardHeader
        title={t.pricing.schedule}
        hint={t.pricing.scheduleHint}
        action={
          <>
            <Button size="sm" variant="secondary" onClick={autoSplit}>
              {t.pricing.autoSplit}
            </Button>
            <Button size="sm" variant="ghost" onClick={addRow}>
              {t.pricing.addInstallment}
            </Button>
          </>
        }
      />

      {loading ? (
        <Spinner label={t.common.loading} />
      ) : (
        <div className="space-y-3 p-5">
          {draft.length === 0 && (
            <p className="py-6 text-center text-sm text-ink-faint">{t.common.empty}</p>
          )}

          {draft.map((row, i) => (
            <div key={row.seq} className="flex items-end gap-2">
              <span className="mb-2.5 w-8 shrink-0 text-center text-xs font-medium tnum text-ink-faint">
                {row.seq}
              </span>
              <div className="min-w-0 flex-1">
                <Field label={i === 0 ? t.pricing.amount : ''}>
                  <Input
                    type="number" min="0" step="0.01" inputMode="decimal" dir="ltr"
                    value={row.amount}
                    onChange={(e) => update(i, { amount: e.target.value })}
                    className="py-2 text-sm tnum"
                  />
                </Field>
              </div>
              <div className="min-w-0 flex-1">
                <Field label={i === 0 ? t.pricing.dueDate : ''}>
                  <Input
                    type="date"
                    value={row.due_date}
                    onChange={(e) => update(i, { due_date: e.target.value })}
                    className="py-2 text-sm"
                  />
                </Field>
              </div>
              <button
                type="button"
                onClick={() => removeRow(i)}
                aria-label={t.common.delete}
                className="mb-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-field text-ink-faint transition-colors hover:bg-danger-soft hover:text-danger"
              >
                ×
              </button>
            </div>
          ))}

          <div className="flex items-center justify-between border-t border-border pt-3">
            <span className="text-xs text-ink-muted">{t.pricing.scheduleTotal}</span>
            <span className={mismatch ? 'text-sm font-semibold tnum text-warn' : 'text-sm font-semibold tnum text-ink'}>
              {formatMoney(total, locale)}
            </span>
          </div>

          {mismatch && (
            <Notice tone="warn">
              {t.pricing.scheduleMismatch} — {formatMoney(price, locale)}
            </Notice>
          )}
          {result && <Notice tone={result.tone}>{result.text}</Notice>}

          <div className="flex justify-end">
            <Button onClick={save} disabled={busy}>
              {busy ? t.common.saving : t.pricing.saveSchedule}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ── what actually came in ──────────────────────────────────────────────── */

function PaymentsCard({
  subscription, entries, loading, error, wallets, onChanged,
}: {
  subscription: SubscriptionDetail;
  entries: LedgerEntry[];
  loading: boolean;
  error: string | null;
  wallets: WalletBalance[];
  onChanged: () => void;
}) {
  const { t, locale } = useI18n();
  const [recording, setRecording] = useState(false);
  const [voiding, setVoiding] = useState<LedgerEntry | null>(null);
  const [detail, setDetail] = useState<LedgerEntry | null>(null);

  return (
    <Card>
      <CardHeader
        title={t.pricing.payments}
        hint={t.pricing.paymentsHint}
        action={
          <Button size="sm" onClick={() => setRecording(true)} disabled={wallets.length === 0}>
            {t.pricing.recordPayment}
          </Button>
        }
      />

      {loading ? (
        <Spinner label={t.common.loading} />
      ) : error ? (
        <ErrorState message={t.common.error} detail={error} />
      ) : entries.length === 0 ? (
        <p className="px-5 py-12 text-center text-sm text-ink-faint">{t.common.empty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {entries.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-medium text-ink">
                    {e.description ?? t.ledger.types[e.entry_type]}
                  </p>
                  {e.voided_at && <Badge tone="danger">{t.pricing.voided}</Badge>}
                  {e.is_test && <Badge tone="warn">{t.common.test}</Badge>}
                  <Badge tone={e.payment_id ? 'info' : 'neutral'}>
                    {e.payment_id ? t.pricing.fromKashier : t.pricing.manual}
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-ink-faint">
                  {formatDateTime(e.occurred_at, locale)} · {e.wallet_name}
                  {e.kashier_transaction_id && (
                    <> · <Mono value={e.kashier_transaction_id} /></>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-end">
                  <Money
                    value={Number(e.amount)}
                    tone={e.voided_at ? 'plain' : e.entry_type === 'gateway_fee' ? 'danger' : 'ok'}
                    className={e.voided_at ? 'line-through opacity-60' : 'font-semibold'}
                  />
                  {/* The same subtraction as the ledger page: this row is one
                      of three numbers, and the other two are the reason the
                      figure above is not what arrived. */}
                  {e.payment_gross !== null && e.entry_type !== 'gateway_fee' && (
                    <p className="tnum text-xs text-ink-faint">
                      {t.finance.youReceived} {formatMoney(Number(e.payment_net ?? 0), locale)}
                    </p>
                  )}
                </div>
                <Button size="sm" variant="secondary" onClick={() => setDetail(e)}>
                  {t.ledgerDetail.open}
                </Button>
                {!e.voided_at && (
                  <Button size="sm" variant="ghost" onClick={() => setVoiding(e)}>
                    {t.pricing.void}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <RecordPaymentModal
        open={recording}
        onClose={() => setRecording(false)}
        subscription={subscription}
        wallets={wallets}
        onSaved={onChanged}
      />
      <VoidModal
        entry={voiding}
        onClose={() => setVoiding(null)}
        onVoided={onChanged}
      />
      <LedgerDetailModal entry={detail} onClose={() => setDetail(null)} />
    </Card>
  );
}

function RecordPaymentModal({
  open, onClose, subscription, wallets, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  subscription: SubscriptionDetail;
  wallets: WalletBalance[];
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [amount, setAmount] = useState('');
  const [walletId, setWalletId] = useState('');
  const [date, setDate] = useState(() => toCairoDateKey(new Date()));
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveWallet =
    walletId || wallets.find((w) => w.is_kashier_default)?.id || wallets[0]?.id || '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    // Goes through add_manual_revenue, not a direct insert: RLS denies writes
    // to ledger_entries, so the wallet movement and the revenue entry stay a
    // single transaction the database controls.
    const { error: err } = await createClient().rpc('add_manual_revenue', {
      p_description: `${t.pricing.subscription} ${subscription.order_id}`,
      p_amount: Number(amount),
      p_wallet_id: effectiveWallet,
      p_student_id: subscription.students?.id ?? subscription.student_id ?? null,
      p_subscription_id: subscription.id,
      p_occurred_at: new Date(`${date}T12:00:00`).toISOString(),
      p_notes: notes.trim() === '' ? null : notes.trim(),
    });

    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    setAmount('');
    setNotes('');
    onSaved();
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title={t.pricing.recordPayment}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={`${t.pricing.amount} *`}>
            <Input
              type="number" min="0.01" step="0.01" inputMode="decimal" dir="ltr"
              value={amount} onChange={(e) => setAmount(e.target.value)} required
            />
          </Field>
          <Field label={t.pricing.paidOn}>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>

        <Field label={`${t.pricing.wallet} *`}>
          <Select value={effectiveWallet} onChange={(e) => setWalletId(e.target.value)} required>
            {wallets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
        </Field>

        <Field label={`${t.pricing.notes} (${t.common.optional})`}>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        {error && <Notice tone="danger">{error}</Notice>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button type="submit" disabled={busy}>
            {busy ? t.common.saving : t.pricing.recordPayment}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function VoidModal({
  entry, onClose, onVoided,
}: { entry: LedgerEntry | null; onClose: () => void; onVoided: () => void }) {
  const { t, locale } = useI18n();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!entry) return;
    setBusy(true);
    setError(null);

    // Nothing financial is deleted, only voided — the row stays, marked.
    const { error: err } = await createClient().rpc('void_ledger_entry', {
      p_entry_id: entry.id,
      p_reason: reason.trim() === '' ? null : reason.trim(),
    });

    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    setReason('');
    onVoided();
    onClose();
  }

  return (
    <Modal open={entry !== null} onClose={onClose} title={t.pricing.voidTitle}>
      <form onSubmit={submit} className="space-y-4">
        {entry && (
          <div className="rounded-field bg-surface-2 px-3.5 py-3 text-sm">
            <p className="text-ink">{entry.description ?? t.ledger.types[entry.entry_type]}</p>
            <p className="mt-0.5 text-xs text-ink-faint">
              {formatMoney(Number(entry.amount), locale)} · {entry.wallet_name} ·{' '}
              {formatDateTime(entry.occurred_at, locale)}
            </p>
          </div>
        )}

        <Field label={`${t.pricing.voidReason} (${t.common.optional})`}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>

        {error && <Notice tone="danger">{error}</Notice>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button type="submit" variant="danger" disabled={busy}>
            {busy ? t.common.saving : t.pricing.void}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
