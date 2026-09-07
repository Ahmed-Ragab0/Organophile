'use client';

import type { ReactNode } from 'react';
import { Badge, Card, cx } from './ui/primitives';
import { useI18n } from '@/lib/i18n/context';
import { formatMoney } from '@/lib/format';
import type { KashierTransferEvent, KashierTxnEvent, TxnStatus } from '@/types/database';

/** Money is not a neutral fact here: green/red must mean in/out consistently. */
export function StatusBadge({ status }: { status: TxnStatus | null | undefined }) {
  const { t } = useI18n();
  if (!status) return <span className="text-ink-faint">—</span>;
  const tone =
    status === 'SUCCESS' ? 'ok'
    : status === 'FAILURE' ? 'danger'
    : status === 'PENDING' || status === 'INITIATED' ? 'warn'
    : 'neutral';
  return <Badge tone={tone}>{t.status[status]}</Badge>;
}

export function EventBadge({ event }: { event: KashierTxnEvent | null | undefined }) {
  const { t } = useI18n();
  if (!event) return <span className="text-ink-faint">—</span>;
  const tone =
    event === 'pay' || event === 'capture' ? 'info'
    : event === 'refund' || event === 'reversal' ? 'danger'
    : 'neutral';
  return <Badge tone={tone}>{t.events[event]}</Badge>;
}

export function TransferBadge({ event }: { event: KashierTransferEvent | null | undefined }) {
  const { t } = useI18n();
  if (!event) return <span className="text-ink-faint">—</span>;
  const map = {
    TRANSFERRED: { tone: 'ok' as const, label: t.payouts.transferred },
    INITIATED: { tone: 'warn' as const, label: t.payouts.initiated },
    FAILED: { tone: 'danger' as const, label: t.payouts.failed },
  };
  const v = map[event];
  return <Badge tone={v.tone}>{v.label}</Badge>;
}

export function MatchBadge({ method }: { method: string | null | undefined }) {
  const { t } = useI18n();
  if (method === 'override') return <Badge tone="brand">{t.payments.matchOverride}</Badge>;
  if (method === 'auto_order_key') return <Badge tone="ok">{t.payments.matchAuto}</Badge>;
  return <Badge tone="warn">{t.payments.matchNone}</Badge>;
}

export function ModeBadge({ mode }: { mode: string | null | undefined }) {
  const { t } = useI18n();
  if (mode !== 'test') return null;
  // Live is the default and needs no chrome; test data must be unmistakable.
  return <Badge tone="warn">{t.common.test}</Badge>;
}

/** A Latin identifier that must not be reordered by RTL layout. */
export function Mono({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-ink-faint">—</span>;
  return <span className="ltr-id text-xs">{value}</span>;
}

export function SignedMoney({ value }: { value: number | null | undefined }) {
  const { locale } = useI18n();
  const n = value ?? 0;
  return (
    <span className={cx('tnum font-medium', n < 0 ? 'text-danger' : n > 0 ? 'text-ink' : 'text-ink-faint')}>
      {formatMoney(n, locale)}
    </span>
  );
}

export function StatCard({
  label, value, hint, tone = 'neutral', icon,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'danger';
  icon?: ReactNode;
}) {
  const accent = {
    neutral: 'text-ink',
    ok: 'text-ok',
    warn: 'text-warn',
    danger: 'text-danger',
  }[tone];

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-ink-muted">{label}</p>
        {icon}
      </div>
      <p className={cx('mt-2 text-2xl font-semibold tnum', accent)}>{value}</p>
      {hint && <p className="mt-1 text-xs text-ink-faint">{hint}</p>}
    </Card>
  );
}
