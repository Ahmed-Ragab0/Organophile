'use client';

import { useI18n } from '@/lib/i18n/context';
import { formatNumber } from '@/lib/format';
import { Card, CardHeader, FillBar, Notice, Skeleton } from '@/components/ui/primitives';
import type { PaymentMatchHealth } from '@/types/database';

/**
 * Is the order-id hypothesis holding?
 *
 * The whole payments <-> subscriptions link rests on one assumption: that
 * ukkera's `order_id` is what Kashier reports back as `merchantOrderId`. It
 * has been an assumption since the schema was written, and an assumption
 * nobody measures stays an assumption forever.
 *
 * There is no way to prove it in advance — we do not control ukkera's
 * checkout, so we cannot know what it puts in that field until it sends one.
 * What we CAN do is count. Every live payment that auto-matches is evidence
 * for; every one that does not is a concrete counter-example with a
 * transaction id attached.
 *
 * The distinction this panel exists to preserve is between "0% matched" and
 * "nothing has happened yet". They look identical in a naive counter and mean
 * opposite things — one is a broken integration, the other is a quiet Tuesday.
 */
export function MatchHealthPanel({
  health, loading,
}: { health: PaymentMatchHealth | null | undefined; loading?: boolean }) {
  const { t, locale } = useI18n();

  if (loading) {
    return (
      <Card>
        <CardHeader title={t.matchHealth.title} hint={t.matchHealth.hint} />
        <div className="space-y-3 p-4">
          <Skeleton className="h-3.5 w-48" />
          <Skeleton className="h-2.5 w-full" />
          <Skeleton className="h-3.5 w-32" />
        </div>
      </Card>
    );
  }

  const payments = health?.payments ?? 0;

  // No live settlement events yet. Say exactly that, and say what would
  // change it, rather than rendering a 0% that reads like a failure.
  if (payments === 0) {
    return (
      <Card>
        <CardHeader title={t.matchHealth.title} hint={t.matchHealth.hint} />
        <div className="p-4">
          <Notice tone="info">
            <strong className="font-semibold">{t.matchHealth.noEvidenceTitle}</strong>
            {' — '}
            {t.matchHealth.noEvidenceBody}
          </Notice>
        </div>
      </Card>
    );
  }

  const auto = health?.auto_matched ?? 0;
  const manual = health?.manually_linked ?? 0;
  const none = health?.unmatched ?? 0;
  const rate = health?.auto_match_rate ?? 0;

  // A handful of payments all matching is encouraging, not conclusive. The
  // threshold is deliberately modest — this is a tutoring business, not a
  // payment processor — but it stops one lucky match reading as proof.
  const CONFIDENT_AT = 10;
  const verdict =
    none > 0 ? 'broken'
      : payments >= CONFIDENT_AT ? 'confirmed'
        : 'promising';

  const tone = verdict === 'broken' ? 'danger' : verdict === 'confirmed' ? 'ok' : 'info';

  return (
    <Card>
      <CardHeader title={t.matchHealth.title} hint={t.matchHealth.hint} />
      <div className="space-y-4 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-2xl font-semibold tnum text-ink display-tight">
            {formatNumber(rate, locale)}%
          </span>
          <span className="text-xs text-ink-muted">
            {`${formatNumber(auto, locale)} / ${formatNumber(payments, locale)} ${t.matchHealth.autoMatched}`}
          </span>
        </div>

        <FillBar value={auto} max={payments} tone={none > 0 ? 'danger' : 'ok'} />

        <dl className="grid grid-cols-3 gap-2 text-center">
          {([
            [t.matchHealth.auto, auto, 'text-ok'],
            [t.matchHealth.manual, manual, 'text-info'],
            [t.matchHealth.none, none, none > 0 ? 'text-danger' : 'text-ink-faint'],
          ] as const).map(([label, value, colour]) => (
            <div key={label} className="rounded-tile bg-surface-2 px-2 py-2.5">
              <dt className="text-[0.6875rem] text-ink-muted">{label}</dt>
              <dd className={`tnum text-lg font-semibold ${colour}`}>
                {formatNumber(value, locale)}
              </dd>
            </div>
          ))}
        </dl>

        <Notice tone={tone}>
          <strong className="font-semibold">
            {verdict === 'broken' ? t.matchHealth.brokenTitle
              : verdict === 'confirmed' ? t.matchHealth.confirmedTitle
                : t.matchHealth.promisingTitle}
          </strong>
          {' — '}
          {verdict === 'broken' ? t.matchHealth.brokenBody
            : verdict === 'confirmed' ? t.matchHealth.confirmedBody
              : `${t.matchHealth.promisingBody} (${formatNumber(payments, locale)}/${formatNumber(CONFIDENT_AT, locale)})`}
        </Notice>
      </div>
    </Card>
  );
}
