'use client';

import { Badge, Card } from './ui/primitives';
import { useI18n } from '@/lib/i18n/context';

export type PriceSource = 'override' | 'package' | 'order' | 'none';

/**
 * What a subscription is worth, and where that number came from.
 *
 * This mirrors `v_subscription_financials` exactly:
 *
 *   coalesce(s.total_due, pk.price, s.amount, 0)
 *
 * It is duplicated in TypeScript for one reason only — to name the source, so
 * the pricing page can say *why* a subscription is worth what it is instead of
 * showing a number with no provenance. The database stays the authority on the
 * amount itself; every figure displayed as money still comes from the view.
 */
export function effectivePrice(subscription: {
  total_due: number | null;
  amount: number | null;
  packages?: { price: number | null } | null;
}): { value: number; source: PriceSource } {
  if (subscription.total_due !== null) {
    return { value: Number(subscription.total_due), source: 'override' };
  }
  const packagePrice = subscription.packages?.price;
  if (packagePrice !== null && packagePrice !== undefined) {
    return { value: Number(packagePrice), source: 'package' };
  }
  if (subscription.amount !== null) {
    return { value: Number(subscription.amount), source: 'order' };
  }
  return { value: 0, source: 'none' };
}

export function PriceSourceBadge({ source }: { source: PriceSource }) {
  const { t } = useI18n();
  const map = {
    override: { tone: 'accent' as const, label: t.pricing.sourceOverride },
    package: { tone: 'brand' as const, label: t.pricing.sourcePackage },
    order: { tone: 'info' as const, label: t.pricing.sourceOrder },
    none: { tone: 'danger' as const, label: t.pricing.sourceNone },
  };
  const v = map[source];
  return <Badge tone={v.tone}>{v.label}</Badge>;
}

/**
 * How a price is decided, stated once at the top of the page.
 *
 * Every row carries a source badge, and a badge with no legend is a puzzle:
 * the reader can see that this subscription says "package" and that one says
 * "order", but not that the first beats the second, or what to change to move
 * a row from one to the other. Four coloured words in a table are decoration
 * until the rule behind them is written down.
 *
 * The order here is the order in the database — coalesce(total_due,
 * package.price, amount, 0) — so the page cannot drift from the view.
 */
export function PriceRules() {
  const { t } = useI18n();

  const steps = [
    { source: 'override' as const, text: t.pricing.ruleOverride },
    { source: 'package' as const, text: t.pricing.rulePackage },
    { source: 'order' as const, text: t.pricing.ruleOrder },
    { source: 'none' as const, text: t.pricing.ruleNone },
  ];

  return (
    <Card className="mb-5 p-4">
      <p className="mb-3 text-sm font-medium text-ink">{t.pricing.rulesTitle}</p>
      <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {steps.map((s, i) => (
          <li
            key={s.source}
            className="flex items-start gap-2.5 rounded-tile bg-surface-2 px-3 py-2.5"
          >
            <span
              aria-hidden
              className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-surface text-[0.6875rem] font-semibold tnum text-ink-muted ring-1 ring-border"
            >
              {i + 1}
            </span>
            <span className="min-w-0">
              <PriceSourceBadge source={s.source} />
              <span className="mt-1 block text-xs leading-relaxed text-ink-muted">{s.text}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-ink-faint">{t.pricing.rulesFooter}</p>
    </Card>
  );
}
