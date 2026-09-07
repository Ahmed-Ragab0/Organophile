'use client';

import { useI18n } from '@/lib/i18n/context';
import { useMode } from '@/lib/mode/context';
import { Notice } from './ui/primitives';

/**
 * Shown on the pages that count money, and only while the mode switch is on
 * test.
 *
 * The switch filters what you can see; it deliberately cannot change what
 * counts. Wallet balances, profit and reports exclude test traffic in the
 * database, which is the invariant that keeps the books reconciling. Silently
 * ignoring the switch on these pages would be worse than saying so.
 */
export function MoneyModeNotice() {
  const { t } = useI18n();
  const { isTest } = useMode();

  if (!isTest) return null;

  return (
    <div className="mb-5">
      <Notice tone="warn">
        <strong className="font-semibold">{t.mode.moneyAlwaysLive}</strong>
        {' — '}
        {t.mode.moneyAlwaysLiveHint}
      </Notice>
    </div>
  );
}
