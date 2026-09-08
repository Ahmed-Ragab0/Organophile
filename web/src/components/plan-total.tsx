'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { createClient } from '@/lib/supabase/client';
import { formatMoney } from '@/lib/format';
import { cx } from '@/components/ui/primitives';

/**
 * The full course price behind an instalment plan, edited in place.
 *
 * It stays null until someone sets it, and a null is shown as "not set" rather
 * than as zero — the two mean opposite things here. Zero would report the
 * student as owing nothing, which is precisely the wrong answer for someone
 * one instalment into three.
 *
 * Commits on blur and on Enter; reverts on Escape. No save button, because a
 * price list that costs a modal per change is a price list nobody keeps current.
 */
export function PlanTotalInput({
  planId, value, onSaved,
}: {
  planId: string;
  value: number | null;
  onSaved: () => void;
}) {
  const { t, locale } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  async function commit() {
    const trimmed = draft.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    setEditing(false);

    if (next !== null && (Number.isNaN(next) || next < 0)) return;
    if (next === value) return;

    setState('saving');
    const { error } = await createClient()
      .from('installment_plans').update({ total_due: next }).eq('id', planId);
    if (error) {
      setState('error');
      setMessage(error.message);
      return;
    }
    setState('idle');
    setMessage(null);
    onSaved();
  }

  if (!editing) {
    return (
      <div>
        <button
          type="button"
          onClick={() => { setDraft(value === null ? '' : String(value)); setEditing(true); }}
          className={cx(
            'mt-0.5 rounded-field px-1.5 py-0.5 -mx-1.5 text-start',
            'transition-colors hover:bg-surface-2',
            state === 'saving' && 'opacity-60',
          )}
        >
          {value === null
            ? <span className="text-sm text-warn">{t.plans.priceUnknown}</span>
            : (
              <span className="font-display text-lg font-semibold text-ink tnum">
                {formatMoney(Number(value), locale)}
              </span>
            )}
        </button>
        {state === 'error' && message && (
          <p className="mt-1 text-xs text-danger">{message}</p>
        )}
      </div>
    );
  }

  return (
    <input
      autoFocus
      type="number"
      inputMode="decimal"
      min={0}
      step="0.01"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); void commit(); }
        if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
      }}
      placeholder={t.plans.totalDue}
      className={cx(
        'mt-0.5 w-full rounded-field border border-accent bg-surface px-2 py-1',
        'font-display text-lg font-semibold text-ink tnum',
        'outline-none ring-2 ring-accent/20',
      )}
    />
  );
}
