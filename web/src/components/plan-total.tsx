'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { createClient } from '@/lib/supabase/client';
import { formatDate, formatMoney } from '@/lib/format';
import { cx } from '@/components/ui/primitives';

/**
 * The two facts about an instalment plan that only a person can supply: what
 * the whole course costs, and when the next payment is expected. Neither can
 * be derived — the remaining instalments have not been bought yet — so both
 * are edited where you find out they are wrong, which is looking at one
 * student.
 *
 * Both commit on blur and on Enter, and revert on Escape. No save button:
 * a figure that costs a modal per change is a figure nobody keeps current.
 */
function InlineEditor({
  planId, column, kind, value, render, placeholder,
  onSaved,
}: {
  planId: string;
  /** The `installment_plans` column this writes. */
  column: 'total_due' | 'next_due_date';
  kind: 'number' | 'date';
  value: string | number | null;
  /** What the resting state looks like. Given the stored value, never a draft. */
  render: () => React.ReactNode;
  placeholder: string;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  async function commit() {
    const trimmed = draft.trim();
    setEditing(false);

    // An emptied box means "not set", which is a different fact from zero and
    // from today. Both columns are nullable precisely so it can be said.
    let next: string | number | null = trimmed === '' ? null : trimmed;
    if (kind === 'number' && next !== null) {
      const parsed = Number(next);
      if (Number.isNaN(parsed) || parsed < 0) return;
      next = parsed;
    }
    if (String(next ?? '') === String(value ?? '')) return;

    setState('saving');
    const { error } = await createClient()
      .from('installment_plans').update({ [column]: next }).eq('id', planId);
    if (error) {
      setState('error');
      setMessage(error.message);
      return;
    }
    setState('idle');
    setMessage(null);
    onSaved();
  }

  if (editing) {
    return (
      <input
        autoFocus
        type={kind === 'number' ? 'number' : 'date'}
        inputMode={kind === 'number' ? 'decimal' : undefined}
        min={kind === 'number' ? 0 : undefined}
        step={kind === 'number' ? '0.01' : undefined}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void commit(); }
          if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
        }}
        placeholder={placeholder}
        className={cx(
          'mt-0.5 w-full rounded-field border border-accent bg-surface px-2 py-1',
          'font-display text-lg font-semibold text-ink tnum',
          'outline-none ring-2 ring-accent/20',
        )}
      />
    );
  }

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
        {render()}
      </button>
      {state === 'error' && message && (
        <p className="mt-1 text-xs text-danger">{message}</p>
      )}
    </div>
  );
}

/**
 * The full course price behind an instalment plan.
 *
 * It stays null until someone sets it, and a null is shown as "not set" rather
 * than as zero — the two mean opposite things here. Zero would report the
 * student as owing nothing, which is precisely the wrong answer for someone
 * one instalment into three.
 */
export function PlanTotalInput({
  planId, value, onSaved,
}: {
  planId: string;
  value: number | null;
  onSaved: () => void;
}) {
  const { t, locale } = useI18n();
  return (
    <InlineEditor
      planId={planId}
      column="total_due"
      kind="number"
      value={value}
      placeholder={t.plans.totalDue}
      onSaved={onSaved}
      render={() =>
        value === null
          ? <span className="text-sm text-warn">{t.plans.priceUnknown}</span>
          : (
            <span className="font-display text-lg font-semibold text-ink tnum">
              {formatMoney(Number(value), locale)}
            </span>
          )}
    />
  );
}

/**
 * When the next instalment is expected.
 *
 * Unset reads as "no date", not as overdue: the plan is an agreement, and an
 * agreement nobody has dated is not a debt anyone is late on.
 */
export function PlanNextDueInput({
  planId, value, inDays, onSaved,
}: {
  planId: string;
  value: string | null;
  /** Negative once the date has passed; supplied by the database. */
  inDays: number | null;
  onSaved: () => void;
}) {
  const { t, locale } = useI18n();
  const late = inDays !== null && inDays < 0;
  return (
    <InlineEditor
      planId={planId}
      column="next_due_date"
      kind="date"
      value={value}
      placeholder={t.plans.nextDue}
      onSaved={onSaved}
      render={() =>
        value === null
          ? <span className="text-sm text-ink-faint">{t.plans.nextDueNoDate}</span>
          : (
            <span
              className={cx(
                'font-display text-lg font-semibold tnum',
                late ? 'text-danger' : 'text-ink',
              )}
            >
              {formatDate(value, locale)}
            </span>
          )}
    />
  );
}
