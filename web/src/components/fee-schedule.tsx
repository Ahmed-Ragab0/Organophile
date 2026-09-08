'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { createClient } from '@/lib/supabase/client';
import { formatDate, formatMoney } from '@/lib/format';
import {
  Badge, Button, Card, CardHeader, Field, Input, Notice, Skeleton,
} from '@/components/ui/primitives';
import type { KashierFeeSchedule } from '@/types/database';
import type { Mode } from '@/lib/mode/mode';

/**
 * The fee Kashier takes but does not report.
 *
 * Kashier's percentage-plus-flat arrives inside every payload and can be
 * checked against it. The bank fee does not arrive at all, so it has to be
 * stated here — which makes this panel the one place where a number in the
 * accounts comes from a person rather than from the gateway. It says so.
 *
 * Effective-dated on purpose. A fee change must not travel backwards and
 * restate months that were already reconciled, so each payment is charged the
 * rate in force on its own transaction date. Editing the date is therefore a
 * real operation, not a correction of a typo, and it is the field most likely
 * to need adjusting — the schedule is seeded from the moment it was created,
 * which is rarely the moment the fee actually started.
 */
export function FeeSchedulePanel({
  mode, kashierReports,
}: {
  mode: Mode;
  /** What Kashier reports as `payoutFees` on its account endpoint. */
  kashierReports?: number | null;
}) {
  const { t, locale } = useI18n();
  const [nonce, setNonce] = useState(0);
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const schedule = useSupabaseQuery<KashierFeeSchedule[]>(
    (sb) =>
      sb.from('kashier_fee_schedule').select('*').eq('mode', mode)
        .order('effective_from', { ascending: false }),
    [mode, nonce],
  );

  const rows = schedule.data ?? [];
  const current = rows[0];

  function beginEdit() {
    if (!current) return;
    setAmount(String(current.bank_fee_flat));
    // datetime-local wants a naive local string; the stored value is UTC.
    setFrom(new Date(current.effective_from).toISOString().slice(0, 16));
    setError(null);
    setEditing(true);
  }

  async function save() {
    if (!current) return;
    const value = Number(amount);
    if (Number.isNaN(value) || value < 0) {
      setError(t.feeSchedule.invalidAmount);
      return;
    }
    setSaving(true);
    setError(null);
    const { error: err } = await createClient()
      .from('kashier_fee_schedule')
      .update({
        bank_fee_flat: value,
        effective_from: new Date(from).toISOString(),
      })
      .eq('id', current.id);
    setSaving(false);
    if (err) { setError(err.message); return; }
    setEditing(false);
    setNonce((v) => v + 1);
  }

  return (
    <Card>
      <CardHeader
        title={t.feeSchedule.title}
        hint={t.feeSchedule.subtitle}
        action={
          !editing && current
            ? <Button size="sm" variant="secondary" onClick={beginEdit}>{t.common.edit}</Button>
            : undefined
        }
      />

      <div className="space-y-4 p-4">
        {schedule.loading && <Skeleton className="h-16 w-full" />}

        {!schedule.loading && !current && (
          <Notice tone="warn">{t.feeSchedule.none}</Notice>
        )}

        {!schedule.loading && current && !editing && (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-ink-muted">{t.position.bankFees}</p>
                <p className="text-xs text-ink-faint">
                  {`${t.feeSchedule.since} ${formatDate(current.effective_from, locale)}`}
                </p>
              </div>
              <span className="shrink-0 font-display text-lg font-semibold tnum text-ink">
                {formatMoney(Number(current.bank_fee_flat), locale)}
                <span className="ms-1.5 text-xs font-normal text-ink-faint">
                  {t.position.perTransaction}
                </span>
              </span>
            </div>

            {/*
              Kashier reports this same figure on its account endpoint, under
              `payoutFees`. Showing it beside ours turns a hand-entered number
              into a checkable one — and the name is worth noticing: "payout"
              fees may mean per transfer rather than per transaction, which is
              a question for Kashier, not something to silently assume either
              way.
            */}
            {kashierReports !== null && kashierReports !== undefined && (
              <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-tile bg-surface-2 px-3 py-2">
                <span className="text-xs text-ink-muted">{t.feeSchedule.kashierReports}</span>
                <span className="flex items-center gap-2">
                  <span className="tnum text-sm font-medium text-ink">
                    {formatMoney(Number(kashierReports), locale)}
                  </span>
                  {Math.abs(Number(kashierReports) - Number(current.bank_fee_flat)) < 0.005
                    ? <Badge tone="ok">{t.feeSchedule.matches}</Badge>
                    : <Badge tone="warn">{t.feeSchedule.differs}</Badge>}
                </span>
              </div>
            )}

            <Notice tone="info">{t.feeSchedule.datedNote}</Notice>

            {rows.length > 1 && (
              <div>
                <p className="mb-1.5 text-xs font-medium text-ink-muted">
                  {t.feeSchedule.history}
                </p>
                <ul className="space-y-1">
                  {rows.slice(1).map((r) => (
                    <li key={r.id} className="flex items-baseline justify-between gap-3 text-xs text-ink-faint">
                      <span>{formatDate(r.effective_from, locale)}</span>
                      <span className="tnum">{formatMoney(Number(r.bank_fee_flat), locale)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {editing && current && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t.feeSchedule.amount}>
                <Input
                  type="number" min="0" step="0.01" inputMode="decimal" dir="ltr"
                  value={amount} onChange={(e) => setAmount(e.target.value)}
                />
              </Field>
              <Field label={t.feeSchedule.effectiveFrom} hint={t.feeSchedule.effectiveFromHint}>
                <Input
                  type="datetime-local" dir="ltr"
                  value={from} onChange={(e) => setFrom(e.target.value)}
                />
              </Field>
            </div>
            {error && <Notice tone="danger">{error}</Notice>}
            <div className="flex gap-2">
              <Button onClick={save} disabled={saving}>
                {saving ? t.common.loading : t.common.save}
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>{t.common.cancel}</Button>
            </div>
          </div>
        )}

        {mode === 'test' && <Badge tone="warn">{t.common.test}</Badge>}
      </div>
    </Card>
  );
}
