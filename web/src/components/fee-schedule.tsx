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
  const [openedWith, setOpenedWith] =
    useState<{ bank_fee_flat: string; effective_from: string } | null>(null);
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
    /*
     * datetime-local wants a naive LOCAL string, and toISOString() produces a
     * UTC one — the comment that used to sit here said the first part and the
     * code did the second. So the box showed UTC as though it were Cairo, and
     * save() read it back AS Cairo: opening the form and pressing save with
     * nothing changed walked the date three hours earlier. Every time. On an
     * effective-dated fee, that silently changes which payments it applies to.
     */
    const d = new Date(current.effective_from);
    setFrom(
      new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16),
    );
    // What the row said when the form opened, so a save cannot overwrite a
    // change made elsewhere since.
    setOpenedWith({
      bank_fee_flat: String(current.bank_fee_flat),
      effective_from: current.effective_from,
    });
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
    const sb = createClient();

    /*
     * This one number restates every financial figure in the app, and a form
     * left open is a loaded gun: on 9 Sep 2026 a page opened before the fee was
     * corrected to zero was saved afterwards and put 5.00 back, silently, with
     * nothing to say it had happened. So the row is re-read and the save is
     * refused if it moved.
     */
    const { data: fresh } = await sb
      .from('kashier_fee_schedule').select('bank_fee_flat, effective_from')
      .eq('id', current.id).single();
    const live = fresh as { bank_fee_flat: number; effective_from: string } | null;
    if (
      live && openedWith
      && (String(live.bank_fee_flat) !== openedWith.bank_fee_flat
        || live.effective_from !== openedWith.effective_from)
    ) {
      setSaving(false);
      setError(t.feeSchedule.changedElsewhere);
      setNonce((v) => v + 1);
      setEditing(false);
      return;
    }

    const { error: err } = await sb
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

      <div className="space-y-3 p-4">
        {schedule.loading && <Skeleton className="h-16 w-full" />}

        {!schedule.loading && !current && (
          <Notice tone="warn">{t.feeSchedule.none}</Notice>
        )}

        {!schedule.loading && current && !editing && (
          <>
            {/*
              Amount, source and date on one line each. This used to stack a
              headline figure, a comparison box and a paragraph of explanation
              into a column beside a much taller panel, which left a card's
              worth of empty space under it. The explanation now lives on the
              date it qualifies, where it is actually read.
            */}
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="text-sm text-ink-muted">{t.position.perTransaction}</span>
              <span className="font-display text-xl font-semibold tnum text-ink">
                {formatMoney(Number(current.bank_fee_flat), locale)}
              </span>
            </div>

            <dl className="space-y-1.5 text-xs">
              {kashierReports !== null && kashierReports !== undefined && (
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-ink-muted">{t.feeSchedule.kashierReports}</dt>
                  <dd className="flex items-center gap-1.5">
                    <span className="tnum text-ink">
                      {formatMoney(Number(kashierReports), locale)}
                    </span>
                    {Math.abs(Number(kashierReports) - Number(current.bank_fee_flat)) < 0.005
                      ? <Badge tone="ok">{t.feeSchedule.matches}</Badge>
                      : <Badge tone="warn">{t.feeSchedule.differs}</Badge>}
                  </dd>
                </div>
              )}
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-ink-muted">{t.feeSchedule.effectiveFrom}</dt>
                <dd className="text-ink">{formatDate(current.effective_from, locale)}</dd>
              </div>
            </dl>

            <p className="text-xs leading-relaxed text-ink-faint">{t.feeSchedule.datedNote}</p>

            {rows.length > 1 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-ink-muted">
                  {`${t.feeSchedule.history} (${rows.length - 1})`}
                </summary>
                <ul className="mt-1.5 space-y-1">
                  {rows.slice(1).map((r) => (
                    <li key={r.id} className="flex items-baseline justify-between gap-3 text-ink-faint">
                      <span>{formatDate(r.effective_from, locale)}</span>
                      <span className="tnum">{formatMoney(Number(r.bank_fee_flat), locale)}</span>
                    </li>
                  ))}
                </ul>
              </details>
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
