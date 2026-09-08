'use client';

import type { ReactNode } from 'react';
import { Badge, Card, cx, FillBar } from './ui/primitives';
import { useI18n } from '@/lib/i18n/context';
import { formatMoney } from '@/lib/format';
import type {
  KashierTransferEvent, KashierTxnEvent, LedgerEntryType,
  PaymentStatus, TxnStatus, WalletBalance,
} from '@/types/database';

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
  const map: Record<KashierTransferEvent, { tone: 'ok' | 'warn' | 'danger' | 'info'; label: string }> = {
    TRANSFERRED: { tone: 'ok', label: t.payouts.transferred },
    PARTIALLY_TRANSFERRED: { tone: 'info', label: t.payouts.transferred },
    IN_TRANSIT: { tone: 'warn', label: t.finance.payoutsInFlight },
    INITIATED: { tone: 'warn', label: t.payouts.initiated },
    FAILED: { tone: 'danger', label: t.payouts.failed },
  };
  const v = map[event];
  return <Badge tone={v.tone}>{v.label}</Badge>;
}

export function MatchBadge({ method }: { method: string | null | undefined }) {
  const { t } = useI18n();
  if (method === 'override') return <Badge tone="brand">{t.payments.matchOverride}</Badge>;
  // The two automatic methods are both correct matches but not equally strong:
  // one is ukkera's own transfer_id, the other the merchantOrderId guess that
  // the first live payment showed to be a display string. Naming them apart
  // keeps that distinction visible instead of averaging it away.
  if (method === 'auto_ukkera_transfer') return <Badge tone="ok">{t.payments.matchUkkera}</Badge>;
  if (method === 'auto_order_key') return <Badge tone="ok">{t.payments.matchAuto}</Badge>;
  return <Badge tone="warn">{t.payments.matchNone}</Badge>;
}

export function ModeBadge({ mode }: { mode: string | null | undefined }) {
  const { t } = useI18n();
  if (mode !== 'test') return null;
  // Live is the default and needs no chrome; test data must be unmistakable.
  return <Badge tone="warn">{t.common.test}</Badge>;
}

/** Payment status of a student or subscription. */
export function PaymentStatusBadge({ status }: { status: PaymentStatus | null | undefined }) {
  const { t } = useI18n();
  if (!status) return <span className="text-ink-faint">—</span>;
  const tone = {
    paid: 'ok', partial: 'warn', unpaid: 'neutral', overdue: 'danger', unknown: 'neutral',
  }[status] as 'ok' | 'warn' | 'neutral' | 'danger';
  return <Badge tone={tone}>{t.statuses[status]}</Badge>;
}

export function LedgerTypeBadge({ type }: { type: LedgerEntryType }) {
  const { t } = useI18n();
  const tone = {
    revenue: 'ok', expense: 'danger',
    transfer_in: 'info', transfer_out: 'info',
    refund: 'warn', reversal: 'warn',
    adjustment_in: 'neutral', adjustment_out: 'neutral',
  }[type] as 'ok' | 'danger' | 'info' | 'warn' | 'neutral';
  return <Badge tone={tone}>{t.ledger.types[type]}</Badge>;
}

/** A Latin identifier that must not be reordered by RTL layout. */
export function Mono({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-ink-faint">—</span>;
  return <span className="ltr-id">{value}</span>;
}

/**
 * Money with its sign made visible.
 * Green up, red down, grey for zero — never left to the reader to infer.
 */
export function SignedMoney({
  value, showSign = true,
}: { value: number | null | undefined; showSign?: boolean }) {
  const { locale } = useI18n();
  const n = Number(value ?? 0);
  const tone = n > 0 ? 'text-ok' : n < 0 ? 'text-danger' : 'text-ink-faint';
  const prefix = showSign && n > 0 ? '+' : '';
  return (
    <span className={cx('tnum font-medium whitespace-nowrap', tone)}>
      {prefix}
      {formatMoney(n, locale)}
    </span>
  );
}

export function Money({
  value, tone = 'auto', className,
}: {
  value: number | null | undefined;
  tone?: 'auto' | 'plain' | 'ok' | 'danger';
  className?: string;
}) {
  const { locale } = useI18n();
  const n = Number(value ?? 0);
  const cls =
    tone === 'plain' ? 'text-ink'
    : tone === 'ok' ? 'text-ok'
    : tone === 'danger' ? 'text-danger'
    : n < 0 ? 'text-danger' : 'text-ink';
  return <span className={cx('tnum whitespace-nowrap', cls, className)}>{formatMoney(n, locale)}</span>;
}

/**
 * One number, named. The emphasised variant gets an accent hairline along the
 * inline edge rather than a ring, so a row of tiles still reads as one row —
 * a ring around one card breaks the grid.
 */
export function StatCard({
  label, value, hint, tone = 'neutral', emphasis = false,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'brand';
  emphasis?: boolean;
}) {
  const accent = {
    neutral: 'text-ink', ok: 'text-ok', warn: 'text-warn',
    danger: 'text-danger', brand: 'text-brand',
  }[tone];

  return (
    <Card className={cx('relative overflow-hidden p-4', emphasis && 'border-accent/25')}>
      {emphasis && (
        // Inset from the corners rather than run edge to edge: a full-height
        // bar has square ends that fight the card's radius.
        <span
          aria-hidden
          className="brand-ramp absolute inset-y-4 start-0 w-1 rounded-e-full"
        />
      )}
      <p className="text-xs font-medium text-ink-muted">{label}</p>
      <p
        className={cx(
          'mt-2 font-display font-semibold tnum display-tight',
          emphasis ? 'text-2xl sm:text-3xl' : 'text-xl sm:text-2xl',
          accent,
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1.5 text-xs text-ink-faint">{hint}</p>}
    </Card>
  );
}

/**
 * The wallet strip — the dashboard's signature element.
 *
 * Each wallet's bar is scaled against the largest balance, so "where my money
 * sits" is legible before a single number is read. Negative balances flip to
 * the danger colour rather than rendering a bar of nothing.
 */
export function WalletStrip({ wallets }: { wallets: WalletBalance[] }) {
  const { t, locale } = useI18n();
  const active = wallets.filter((w) => w.is_active);
  const max = Math.max(1, ...active.map((w) => Math.abs(Number(w.balance ?? 0))));

  if (active.length === 0) {
    return <p className="px-5 py-8 text-center text-sm text-ink-faint">{t.common.empty}</p>;
  }

  return (
    <div className="grid gap-px overflow-hidden rounded-b-card bg-border sm:grid-cols-2 lg:grid-cols-3">
      {active.map((w) => {
        const balance = Number(w.balance ?? 0);
        return (
          <div key={w.id} className="bg-surface p-4">
            <div className="flex items-start justify-between gap-2">
              <p className="truncate text-sm font-medium text-ink">{w.name}</p>
              {w.is_kashier_default && <Badge tone="accent">{t.wallets.kashierDefault}</Badge>}
            </div>
            <p
              className={cx(
                'mt-1.5 font-display text-xl font-semibold tnum',
                balance < 0 ? 'text-danger' : 'text-ink',
              )}
            >
              {formatMoney(balance, locale)}
            </p>
            <div className="mt-2.5">
              <FillBar value={balance} max={max} tone={balance < 0 ? 'danger' : 'brand'} />
            </div>
            <p className="mt-2 text-xs text-ink-faint">
              {t.wallets[w.type]} · {w.entries} {t.wallets.entries}
            </p>
          </div>
        );
      })}
    </div>
  );
}
