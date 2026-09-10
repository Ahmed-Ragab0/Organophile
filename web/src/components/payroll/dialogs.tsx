'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n/context';
import { createClient } from '@/lib/supabase/client';
import { dbErrorText } from '@/lib/db-errors';
import { formatDate, formatMoney, toCairoDateKey } from '@/lib/format';
import { messageVariables, renderTemplate, whatsappLink } from '@/lib/payroll';
import {
  Button, Field, Input, Modal, Notice, Select, Textarea,
} from '@/components/ui/primitives';
import { Money } from '@/components/domain';
import { MonthName, SignedAmount, usePayrollReason } from './parts';
import type {
  PayrollResult, PayslipRow, SalaryComponentRow, WalletBalance,
} from '@/types/database';

/* ------------------------------------------------------------ the payslip */

/**
 * What a salary is made of, edited one line at a time.
 *
 * The base is a field and everything else is a row, which mirrors the
 * database exactly: the base is a column on the payslip and the rest are
 * items whose sum the database keeps. Nothing here computes a total — every
 * figure shown comes back from the server after the write, so the screen can
 * never disagree with the books.
 */
export function PayslipModal({
  slip, components, open, onClose, onSaved, mayWrite,
}: {
  slip: PayslipRow;
  components: SalaryComponentRow[];
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  mayWrite: boolean;
}) {
  const { t, locale } = useI18n();
  const [componentId, setComponentId] = useState('');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [base, setBase] = useState(String(slip.base_salary));
  const [note, setNote] = useState(slip.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const frozen = slip.paid_at !== null || !mayWrite;
  const usable = components.filter((c) => c.is_active);

  async function addLine() {
    if (!componentId || amount === '') return;
    setBusy(true);
    setError(null);
    // `direction` is deliberately not sent: the database snapshots it from the
    // component, so a component later flipped from earning to deduction
    // cannot re-sign a line somebody already agreed to.
    const { error: err } = await createClient().from('payslip_items').insert({
      payslip_id: slip.id,
      component_id: componentId,
      amount: Number(amount),
      label: label.trim() === '' ? null : label.trim(),
    });
    setBusy(false);
    if (err) { setError(dbErrorText(err, t)); return; }
    setComponentId('');
    setLabel('');
    setAmount('');
    onSaved();
  }

  async function removeLine(id: string) {
    setBusy(true);
    setError(null);
    const { error: err } = await createClient().from('payslip_items').delete().eq('id', id);
    setBusy(false);
    if (err) { setError(dbErrorText(err, t)); return; }
    onSaved();
  }

  async function saveSlip() {
    setBusy(true);
    setError(null);
    const { error: err } = await createClient()
      .from('payslips')
      .update({ base_salary: Number(base), note: note.trim() === '' ? null : note.trim() })
      .eq('id', slip.id);
    setBusy(false);
    if (err) { setError(dbErrorText(err, t)); return; }
    onSaved();
  }

  const baseChanged = Number(base) !== Number(slip.base_salary)
    || (note.trim() || null) !== (slip.note ?? null);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t.payroll.payslipOf.replace('{name}', slip.employee_name)}
      footer={<Button variant="ghost" onClick={onClose}>{t.common.close}</Button>}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-muted">
          <span><MonthName value={slip.period_month} /></span>
          {slip.paid_at && (
            <span>
              {t.payroll.paidAt} {formatDate(slip.paid_at, locale)}
              {slip.paid_wallet_name && ` · ${t.payroll.paidVia} ${slip.paid_wallet_name}`}
            </span>
          )}
        </div>

        {slip.paid_at !== null && <Notice tone="ok">{t.payroll.frozenNote}</Notice>}

        <Field label={t.payroll.editBase} hint={frozen ? undefined : t.payroll.editBaseHint}>
          <Input
            type="number"
            min={0}
            step="0.01"
            value={base}
            disabled={frozen}
            onChange={(e) => setBase(e.target.value)}
          />
        </Field>

        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-muted">{t.payroll.lines}</p>
          {slip.items.length === 0 ? (
            <p className="rounded-field border border-dashed border-border px-3.5 py-4 text-center text-xs text-ink-faint">
              {t.payroll.noLines}
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-field border border-border">
              {slip.items.map((it) => (
                <li key={it.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-ink">{it.label}</span>
                    <span className="mt-0.5 block text-xs text-ink-faint">
                      {locale === 'en' ? (it.component_name_en ?? it.component_name) : it.component_name}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <SignedAmount amount={it.amount} direction={it.direction} />
                    {!frozen && (
                      <button
                        type="button"
                        onClick={() => void removeLine(it.id)}
                        disabled={busy}
                        aria-label={t.payroll.removeLine}
                        title={t.payroll.removeLine}
                        className="grid h-6 w-6 place-items-center rounded-chip text-ink-faint transition-colors hover:bg-danger-soft hover:text-danger"
                      >
                        ×
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {!frozen && (
          <div className="rounded-field border border-border bg-surface-2 p-3">
            <div className="grid gap-2.5 sm:grid-cols-2">
              <Field label={t.payroll.lineKind}>
                <Select value={componentId} onChange={(e) => setComponentId(e.target.value)}>
                  <option value="">—</option>
                  {usable.map((c) => (
                    <option key={c.id} value={c.id}>
                      {(locale === 'en' ? (c.name_en ?? c.name) : c.name)}
                      {' · '}
                      {c.direction === 'earning' ? t.payroll.earning : t.payroll.deduction}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t.payroll.amount}>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </Field>
            </div>
            <div className="mt-2.5">
              <Field label={t.payroll.lineLabel} hint={t.common.optional}>
                <Input value={label} onChange={(e) => setLabel(e.target.value)} />
              </Field>
            </div>
            <div className="mt-3 flex justify-end">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void addLine()}
                disabled={busy || !componentId || amount === ''}
              >
                {t.payroll.addLine}
              </Button>
            </div>
          </div>
        )}

        <Field label={t.payroll.slipNote}>
          <Textarea value={note} disabled={frozen} onChange={(e) => setNote(e.target.value)} />
        </Field>

        <dl className="space-y-1.5 rounded-field bg-surface-2 px-3.5 py-3 text-sm">
          <Row label={t.payroll.baseSalary} value={<Money value={slip.base_salary} tone="plain" />} />
          <Row label={t.payroll.additions} value={<Money value={slip.earnings_total} tone="ok" />} />
          <Row
            label={t.payroll.deductionsShort}
            value={<Money value={slip.deductions_total} tone="danger" />}
          />
          <div className="border-t border-border pt-1.5">
            <Row
              label={t.payroll.net}
              value={<strong className="font-display text-base"><Money value={slip.net_amount} tone="plain" /></strong>}
            />
          </div>
        </dl>

        {error && <Notice tone="danger">{error}</Notice>}

        {!frozen && baseChanged && (
          <div className="flex justify-end">
            <Button onClick={() => void saveSlip()} disabled={busy}>
              {busy ? t.common.saving : t.common.save}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/* ---------------------------------------------------------------- paying */

/**
 * Paying one salary.
 *
 * The wallet's balance is shown beside the choice and the shortfall is a
 * warning, never a refusal — money leaves this system for the real world, and
 * a wallet that reads low because a cash top-up has not been entered yet must
 * not be able to stop payroll.
 */
export function PayDialog({
  slip, wallets, defaultWalletId, open, onClose, onPaid,
}: {
  slip: PayslipRow;
  wallets: WalletBalance[];
  defaultWalletId: string | null;
  open: boolean;
  onClose: () => void;
  onPaid: () => void;
}) {
  const { t, locale } = useI18n();
  const reasonText = usePayrollReason();
  const [walletId, setWalletId] = useState(defaultWalletId ?? wallets[0]?.id ?? '');
  const [when, setWhen] = useState(toCairoDateKey(new Date()));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
   * Paying a salary is the same call for everybody and does not always pay.
   * Somebody who cannot authorise spending raises a request instead, and the
   * dialog has to say which happened rather than closing identically on both.
   */
  const [sent, setSent] = useState(false);

  const wallet = wallets.find((w) => w.id === walletId);
  const balance = Number(wallet?.balance ?? 0);
  const short = wallet !== undefined && balance < Number(slip.net_amount);

  async function pay() {
    setBusy(true);
    setError(null);
    const { data, error: err } = await createClient().rpc('pay_payslip', {
      p_payslip_id: slip.id,
      p_wallet_id: walletId === '' ? null : walletId,
      // Noon Cairo rather than midnight: a salary dated at the boundary can
      // land on the previous day in UTC, and the ledger aggregates by Cairo day.
      p_occurred_at: `${when}T12:00:00+02:00`,
      p_note: note.trim() === '' ? null : note.trim(),
    });
    setBusy(false);
    if (err) { setError(dbErrorText(err, t)); return; }
    const result = data as PayrollResult | null;
    if (!result?.ok) { setError(reasonText(result?.reason)); return; }
    onPaid();
    if (result.pending) { setSent(true); return; }
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t.payroll.payTitle.replace('{name}', slip.employee_name)}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
          <Button onClick={() => void pay()} disabled={busy || walletId === ''}>
            {busy ? t.common.saving : `${t.payroll.confirmPay} ${formatMoney(slip.net_amount, locale)}`}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        {sent && (
          <Notice tone="ok">
            <strong className="block">{t.approvals.sentTitle}</strong>
            {t.approvals.sentPayslip}
          </Notice>
        )}

        <dl className="space-y-1.5 rounded-field bg-surface-2 px-3.5 py-3 text-sm">
          <Row label={t.payroll.employee} value={<span className="text-ink">{slip.employee_name}</span>} />
          <Row label={t.payroll.forMonth} value={<MonthName value={slip.period_month} />} />
          <Row
            label={t.payroll.net}
            value={<strong className="font-display text-base"><Money value={slip.net_amount} tone="plain" /></strong>}
          />
        </dl>

        <Field label={t.payroll.fromWallet}>
          <Select value={walletId} onChange={(e) => setWalletId(e.target.value)}>
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} · {formatMoney(Number(w.balance ?? 0), locale)}
              </option>
            ))}
          </Select>
        </Field>

        {wallet && (
          <p className="flex items-center justify-between text-xs text-ink-muted">
            <span>{t.payroll.balanceAfter}</span>
            <Money value={balance - Number(slip.net_amount)} />
          </p>
        )}
        {short && <Notice tone="warn">{t.payroll.balanceWarning}</Notice>}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.payroll.payDate}>
            <Input type="date" value={when} onChange={(e) => setWhen(e.target.value)} />
          </Field>
          <Field label={t.payroll.payNote} hint={t.common.optional}>
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>

        <Notice tone="info">{t.payroll.ledgerNote}</Notice>
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Modal>
  );
}

/** Undoing a payment: the entry is voided, and the money comes back. */
export function ReverseDialog({
  slip, open, onClose, onDone,
}: {
  slip: PayslipRow;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const reasonText = usePayrollReason();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    const { data, error: err } = await createClient().rpc('unpay_payslip', {
      p_payslip_id: slip.id,
      p_reason: reason.trim() === '' ? null : reason.trim(),
    });
    setBusy(false);
    if (err) { setError(dbErrorText(err, t)); return; }
    const result = data as PayrollResult | null;
    if (!result?.ok) { setError(reasonText(result?.reason)); return; }
    onDone();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t.payroll.reverseTitle.replace('{name}', slip.employee_name)}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
          <Button variant="danger" onClick={() => void run()} disabled={busy}>
            {busy ? t.common.saving : t.payroll.confirmReverse}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <Notice tone="warn">{t.payroll.reverseHint}</Notice>
        <Field label={t.payroll.reverseReason} hint={t.common.optional}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------- message */

/**
 * The thank-you, ready to send.
 *
 * The text is editable here without touching the saved template: one message
 * occasionally wants a sentence the others do not, and forcing that through
 * the template would change it for everybody. Sending is a wa.me link rather
 * than an API — it opens the owner's own WhatsApp with the message typed, so
 * it goes out as a person writing to a colleague.
 */
export function ThanksModal({
  slip, template, company, open, onClose, onSent,
}: {
  slip: PayslipRow;
  template: string;
  company: string;
  open: boolean;
  onClose: () => void;
  onSent: () => void;
}) {
  const { t, locale } = useI18n();
  const vars = messageVariables(slip, company, locale);
  const [text, setText] = useState(() => renderTemplate(template, vars));
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const link = whatsappLink(slip.phone, text);

  async function markSent() {
    setBusy(true);
    await createClient()
      .from('payslips')
      .update({ message_sent_at: new Date().toISOString() })
      .eq('id', slip.id);
    setBusy(false);
    onSent();
  }

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t.payroll.sendTitle.replace('{name}', slip.employee_name)}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t.common.close}</Button>
          <Button variant="secondary" onClick={() => void copy()}>
            {copied ? t.payroll.copied : t.payroll.copyMessage}
          </Button>
          {link !== null && (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => void markSent()}
              className="brand-ramp inline-flex items-center justify-center gap-2 rounded-field px-4 py-2.5 text-sm font-medium text-white shadow-card transition-[box-shadow,filter] duration-150 ease-soft hover:brightness-110 hover:shadow-raised"
            >
              {t.payroll.sendWhatsapp}
            </a>
          )}
        </>
      )}
    >
      <div className="space-y-3">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="min-h-44 leading-relaxed"
        />
        {link === null && <Notice tone="warn">{t.payroll.noPhone}</Notice>}
        {slip.message_sent_at && (
          <Notice tone="ok">
            {t.payroll.messageSentAt} · {formatDate(slip.message_sent_at, locale)}
          </Notice>
        )}
        {busy && <p className="text-xs text-ink-faint">{t.common.saving}</p>}
      </div>
    </Modal>
  );
}

/** The printable document, one click away and in its own tab. */
export function InvoiceLink({ id, label }: { id: string; label: string }) {
  return (
    <Link
      href={`/payslip/${id}`}
      target="_blank"
      className="inline-flex items-center justify-center gap-2 rounded-field border border-border bg-surface px-3 py-1.5 text-xs font-medium text-ink shadow-card transition-colors hover:bg-surface-2"
    >
      {label}
    </Link>
  );
}
