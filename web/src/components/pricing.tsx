'use client';

import { Badge } from './ui/primitives';
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
