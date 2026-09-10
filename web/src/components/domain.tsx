'use client';

import type { ReactNode } from 'react';
import { Badge, Card, cx, FillBar } from './ui/primitives';
import { useI18n } from '@/lib/i18n/context';
import { formatDate, formatMoney, formatNumber } from '@/lib/format';
import type {
  KashierTransferEvent, KashierTxnEvent, LedgerEntryType, PackageKind, PlanStatus,
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
    // Amber, not red: a fee is withheld from the payment, not spent.
    gateway_fee: 'warn',
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

/** Where an instalment plan has got to. */
export function PlanStatusBadge({ status }: { status: PlanStatus }) {
  const { t } = useI18n();
  const tone = {
    paid: 'ok', partial: 'info', unpaid: 'warn', unknown: 'neutral', closed: 'neutral',
  }[status] as 'ok' | 'info' | 'warn' | 'neutral';
  return <Badge tone={tone}>{t.plans.statuses[status]}</Badge>;
}

/** What the student bought: the whole course, a chapter, or an instalment. */
/**
 * Colour belongs to the three kinds that change how a purchase behaves. A kind
 * the owner added later means something to them and nothing to this file, so
 * it gets the neutral tone rather than a colour picked at random.
 */
const KIND_TONES: Record<string, 'ok' | 'info' | 'warn'> = {
  full: 'ok', chapter: 'info', installment: 'warn',
};

export function PackageKindBadge({
  kind, label,
}: {
  kind: PackageKind | null | undefined;
  /** The kind's current name from the database. Falls back to the built-in
      dictionary, which only knows the four seeded codes. */
  label?: string;
}) {
  const { t } = useI18n();
  // "Unspecified" is the absence of an answer, and a badge saying so is noise
  // on every row that has not been categorised.
  if (!kind || kind === 'other') return null;
  const text = label || t.plans.kinds[kind as keyof typeof t.plans.kinds] || kind;
  return <Badge tone={KIND_TONES[kind] ?? 'neutral'}>{text}</Badge>;
}

/**
 * What this business calls a level: "أورجانيك 3", never "المستوى 3".
 *
 * Nobody here says "level 3" — the courses are named Organic 1 to Organic 4
 * and that is the whole vocabulary. A label the staff would not use out loud
 * is a label they have to translate every time they read it.
 *
 * The digit stays Latin because every number in this app does: the locale tag
 * is `ar-EG-u-nu-latn`, so 300.00 and 2027 read the same way here as they do
 * on the Kashier dashboard being reconciled against.
 *
 * Exported unwrapped as well as as a badge, because the same words have to
 * appear inside a <select> option and an active-filter chip, and three
 * spellings of one name is how a screen stops reading as one thing.
 */
export function levelName(
  level: number,
  subject: string,
  locale: 'ar' | 'en',
): string {
  return `${subject} ${formatNumber(level, locale)}`;
}

export function LevelBadge({
  level, tone = 'brand',
}: {
  level: number | null | undefined;
  tone?: 'brand' | 'neutral';
}) {
  const { t, locale } = useI18n();
  if (level === null || level === undefined) return null;
  return <Badge tone={tone}>{levelName(level, t.courseInfo.subjectOrganic, locale)}</Badge>;
}

/**
 * The next payment owed on a row: how much, when, and how close that is.
 *
 * Three lines rather than a date, because a date alone makes the reader do the
 * subtraction — and the whole reason to put this on a list is so that "late"
 * is visible without reading every row carefully. The day count comes from the
 * database, so lateness never depends on the viewer's clock.
 */
export function NextDueCell({
  date, amount, inDays,
}: {
  date: string | null | undefined;
  amount: number | null | undefined;
  inDays: number | null | undefined;
}) {
  const { t, locale } = useI18n();

  if (amount === null || amount === undefined) {
    return <span className="text-ink-faint">—</span>;
  }

  const days = inDays ?? null;
  const late = days !== null && days < 0;
  const relative = days === null
    ? null
    : days < 0
      ? t.plans.overdueByDays.replace('{n}', formatNumber(Math.abs(days), locale))
      : days === 0
        ? t.plans.dueToday
        : t.plans.dueInDays.replace('{n}', formatNumber(days, locale));

  return (
    <div className="min-w-0 text-end">
      <p className={cx('tnum text-sm font-medium', late ? 'text-danger' : 'text-ink')}>
        {formatMoney(Number(amount), locale)}
      </p>
      <p className="text-xs text-ink-faint">
        {date ? formatDate(date, locale) : t.plans.nextDueNoDate}
      </p>
      {relative && (
        <p className={cx('text-xs', late ? 'text-danger' : 'text-ink-muted')}>{relative}</p>
      )}
    </div>
  );
}

/**
 * Instalments as a row of pips: filled for paid, hollow for still to come.
 * "2 of 3" is countable at a glance in a way a fraction is not, and the count
 * is small enough that drawing it beats reading it.
 */
export function InstallmentPips({ paid, total }: { paid: number; total: number }) {
  const { t } = useI18n();
  const n = Math.max(total, paid, 1);
  return (
    <span className="inline-flex items-center gap-1.5" aria-label={`${paid} ${t.plans.ofCount} ${n}`}>
      <span className="flex gap-1" aria-hidden>
        {Array.from({ length: Math.min(n, 12) }, (_, i) => (
          <span
            key={i}
            className={cx(
              'h-2 w-2 rounded-full',
              i < paid ? 'bg-ok' : 'bg-surface-3 ring-1 ring-inset ring-border',
            )}
          />
        ))}
      </span>
      <span className="text-xs text-ink-muted tnum">{paid}/{n}</span>
    </span>
  );
}
