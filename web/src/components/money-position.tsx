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
 *   collected − refunds − fee − VAT on the fee − bank fee = net revenue
 *   net revenue − transferred − in flight = still at Kashier
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
  const available = position?.kashier_available;
  const synced = position?.kashier_synced_at;

  /*
   * Kashier's answer versus ours, on a basis that can actually be compared.
   *
   * The primary account reports totalBalance 100.57 against availableBalance 0
   * and onHoldBalance 0 — the three do not sum, so there is a bucket Kashier
   * does not break out, and `available` is only what is withdrawable this
   * minute. `total` is the like-for-like figure.
   *
   * It is NET. The balance is credited with each payment's settled_amount —
   * gross minus Kashier's commission and its VAT — which the account API
   * proves to the piastre: 95.84 + 95.67 = 191.51, the exact balance reported
   * with two payments settled and a third still in the window.
   *
   * This used to compare against our GROSS figure, on the belief that Kashier
   * took its fee only at payout. That comparison can never reach zero: once
   * everything settles it stays short by exactly the fees, for ever. Net
   * against net is the one that closes.
   */
  const kashierHas = reported === null || reported === undefined ? null : n(reported);
  const ourNet = n(position?.awaiting_payout);
  const gap = kashierHas === null ? null : kashierHas - ourNet;

  /*
   * How big a difference has to be before it means anything.
   *
   * A flat 0.5 EGP threshold called a 0.57 difference on a 100 EGP balance
   * "transactions never reached the system" — technically true and completely
   * unhelpful. What matters is the difference relative to the money involved,
   * with a floor so that small absolute amounts never raise an alarm.
   */
  const scale = Math.max(Math.abs(kashierHas ?? 0), Math.abs(ourNet), 1);
  const minorLimit = Math.max(2, scale * 0.01);
  const gapMatters = gap !== null && Math.abs(gap) > minorLimit;
  const gapMinor = gap !== null && Math.abs(gap) > 0.5 && !gapMatters;

  /*
   * Kashier says it transferred money out while this system was already
   * recording, and no payout row exists for it.
   *
   * The first version of this notice blamed the transfers webhook. That was
   * wrong: the REST pull is the route this system uses, and it was answering
   * 400 because of one bad query parameter. So the notice states the FACT and
   * leaves the cause to the sync's own error message, which now carries
   * Kashier's words. A screen that names the wrong cause is worse than one
   * that names none.
   */
  const transferUnheard =
    n(position?.transfers_count) === 0
    && position?.kashier_last_transfer_at != null
    && position?.our_records_start != null
    && new Date(position.kashier_last_transfer_at) > new Date(position.our_records_start);

  // Two very different causes produce a gap, and they need opposite actions.
  const sinceSync = n(position?.collected_since_sync);
  // Age comes from the database, not the browser: a money reconciliation must
  // not depend on the viewer's clock being right.
  const hoursSinceLatest = position?.hours_since_latest_payment ?? null;

  const diagnosis = gapMinor
    // Real but immaterial. Named rather than hidden: a figure that quietly
    // rounds away is worse than one that says it is small.
    ? { tone: 'info' as const, text: t.position.gapMinor }
    : !gapMatters
    ? null
    : sinceSync > 0
      ? { tone: 'info' as const, text: t.position.gapStale }
      : gap! < 0
        ? (hoursSinceLatest !== null && hoursSinceLatest < 72
          ? { tone: 'info' as const, text: t.position.gapSettling }
          : { tone: 'warn' as const, text: t.position.gapMissingAtKashier })
        : { tone: 'warn' as const, text: t.position.gapExtraAtKashier };

  const steps = [
    { key: 'gross', label: t.position.gross, value: n(position?.gross), tone: 'ink' as const, hint: t.position.grossHint },
    { key: 'refunded', label: t.position.refunded, value: -n(position?.refunded), tone: 'sub' as const },
    { key: 'fees', label: t.position.fees, value: -n(position?.fees), tone: 'sub' as const, hint: t.position.feesHint },
    // VAT is charged on Kashier's fee, not on the sale, so it is a deduction
    // in its own right. Folding it into the fee above would make the chain
    // stop matching the transaction breakdown on Kashier's dashboard.
    { key: 'vat', label: t.position.vat, value: -n(position?.vat), tone: 'sub' as const, hint: t.position.vatHint },
    // Separate again: this one Kashier does not report on the transaction, so
    // it is the only line here that comes from our own schedule.
    {
      key: 'bankFees',
      label: t.position.bankFees,
      value: -n(position?.bank_fees),
      tone: 'sub' as const,
      hint: n(position?.bank_fee_current) > 0
        ? `${money(position?.bank_fee_current)} ${t.position.perTransaction}`
        : t.position.bankFeesHint,
    },
    { key: 'net', label: t.position.netRevenue, value: n(position?.net_revenue), tone: 'total' as const, hint: t.position.netRevenueHint },
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
            {kashierHas === null ? '—' : money(kashierHas)}
          </span>
        </div>

        {kashierHas !== null && (
          <dl className="mt-2 grid grid-cols-2 gap-2">
            <div className="rounded-tile bg-surface-2 px-3 py-2">
              <dt className="text-[0.6875rem] text-ink-muted">{t.position.available}</dt>
              <dd className="tnum text-sm font-medium text-ink">{money(available)}</dd>
            </div>
            <div className="rounded-tile bg-surface-2 px-3 py-2">
              <dt className="text-[0.6875rem] text-ink-muted">{t.position.ourNet}</dt>
              <dd className="tnum text-sm font-medium text-ink">{money(ourNet)}</dd>
            </div>
          </dl>
        )}

        {/*
          Kashier's own last payout, and whether we ever heard about it.

          A transfer dated before our records simply predates the system. One
          dated AFTER them that produced no payout row is a different thing
          entirely: Kashier moved money and nothing told us. That is not a
          reconciliation gap to think about, it is a webhook that is not
          arriving, and only the second case is worth raising.
        */}
        {position?.kashier_last_transfer != null && n(position.kashier_last_transfer) > 0 && (
          <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2 rounded-tile bg-surface-2 px-3 py-2">
            <span className="text-[0.6875rem] text-ink-muted">
              {t.position.kashierLastTransfer}
              {position.kashier_last_transfer_at && (
                <span className="ms-1 text-ink-faint">
                  {formatDateTime(position.kashier_last_transfer_at, locale)}
                </span>
              )}
            </span>
            <span className="tnum text-sm font-medium text-ink">
              {money(position.kashier_last_transfer)}
            </span>
          </div>
        )}

        {transferUnheard && (
          <div className="mt-2">
            <Notice tone="warn">{t.position.transferUnheard}</Notice>
          </div>
        )}

        {gap !== null && (
          <div className="mt-3">
            <Notice tone={diagnosis?.tone ?? 'ok'}>
              {diagnosis
                ? `${diagnosis.text} (${money(Math.abs(gap))})`
                : t.position.gapOk}
            </Notice>
          </div>
        )}
      </div>
    </Card>
  );
}
