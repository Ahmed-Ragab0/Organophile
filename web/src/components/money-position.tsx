'use client';

import { useI18n } from '@/lib/i18n/context';
import { formatDateTime, formatMoney } from '@/lib/format';
import { Badge, Card, CardHeader, cx, Notice, Spinner } from './ui/primitives';
import type { MoneyPosition } from '@/types/database';

/**
 * Where the money is, as a chain rather than a list of tiles.
 *
 * The whole point is that these numbers are derived from each other:
 *
 *   collected − refunds − fees = owed to you
 *   owed − transferred − in flight = still at Kashier
 *
 * A grid of four equal cards hides that. Reading it left to right as
 * subtraction is the only layout that makes the arithmetic checkable by eye,
 * which is what someone reconciling against the Kashier dashboard is doing.
 */
export function MoneyPositionPanel({
  position, loading,
}: { position: MoneyPosition | null | undefined; loading?: boolean }) {
  const { t, locale } = useI18n();

  if (loading) {
    return <Card><Spinner label={t.common.loading} /></Card>;
  }

  const n = (v: number | null | undefined) => Number(v ?? 0);
  const money = (v: number | null | undefined) => formatMoney(n(v), locale);

  const reported = position?.kashier_reported_balance;
  const synced = position?.kashier_synced_at;
  // Kashier's own answer versus ours. Compared only once a sync has happened —
  // before that there is nothing to disagree with.
  const gap = reported === null || reported === undefined
    ? null
    : n(reported) - n(position?.awaiting_payout);
  const gapMatters = gap !== null && Math.abs(gap) > 0.5;

  const steps = [
    { key: 'gross', label: t.position.gross, value: n(position?.gross), tone: 'ink' as const, hint: t.position.grossHint },
    { key: 'refunded', label: t.position.refunded, value: -n(position?.refunded), tone: 'sub' as const },
    { key: 'fees', label: t.position.fees, value: -n(position?.fees), tone: 'sub' as const },
    { key: 'net', label: t.position.netSettled, value: n(position?.net_settled), tone: 'total' as const, hint: t.position.netSettledHint },
    { key: 'transferred', label: t.position.transferred, value: -n(position?.transferred), tone: 'ok' as const },
    { key: 'inflight', label: t.position.inFlight, value: -n(position?.in_flight), tone: 'sub' as const },
    { key: 'awaiting', label: t.position.awaiting, value: n(position?.awaiting_payout), tone: 'total' as const, hint: t.position.awaitingHint },
  ];

  return (
    <Card>
      <CardHeader
        title={t.position.title}
        hint={t.position.subtitle}
        action={
          synced
            ? <Badge tone="neutral">{`${t.finance.syncedAt}: ${formatDateTime(synced, locale)}`}</Badge>
            : <Badge tone="warn">{t.position.neverSynced}</Badge>
        }
      />

      <ol className="divide-y divide-border">
        {steps.map((s) => (
          <li
            key={s.key}
            className={cx(
              'flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-3',
              s.tone === 'total' && 'bg-surface-2/60',
            )}
          >
            <div className="min-w-0">
              <p
                className={cx(
                  'truncate text-sm',
                  s.tone === 'total' ? 'font-semibold text-ink' : 'text-ink-muted',
                )}
              >
                {s.label}
              </p>
              {s.hint && <p className="text-xs text-ink-faint">{s.hint}</p>}
            </div>
            <span
              className={cx(
                'shrink-0 tnum whitespace-nowrap',
                s.tone === 'total' ? 'font-display text-lg font-semibold text-ink' : 'text-sm',
                s.tone === 'sub' && 'text-ink-muted',
                s.tone === 'ok' && 'text-ok',
              )}
            >
              {/* Deductions carry their sign, so the column reads as a sum. */}
              {s.value < 0 ? `− ${money(Math.abs(s.value))}` : money(s.value)}
            </span>
          </li>
        ))}
      </ol>

      <div className="border-t border-border px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-ink-muted">{t.position.kashierSays}</p>
            <p className="text-xs text-ink-faint">{t.position.kashierSaysHint}</p>
          </div>
          <span className="shrink-0 font-display text-lg font-semibold tnum text-ink">
            {reported === null || reported === undefined ? '—' : money(reported)}
          </span>
        </div>

        {gap !== null && (
          <div className="mt-3">
            <Notice tone={gapMatters ? 'warn' : 'ok'}>
              {gapMatters
                ? `${t.position.gapWarn} (${money(gap)})`
                : t.position.gapOk}
            </Notice>
          </div>
        )}
      </div>
    </Card>
  );
}
