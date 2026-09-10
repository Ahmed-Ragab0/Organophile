'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useI18n } from '@/lib/i18n/context';
import { formatMoney } from '@/lib/format';
import { monthLabel, PAYROLL_FLOW } from '@/lib/payroll';
import { Badge, cx } from '@/components/ui/primitives';
import type { PayrollStatus, SalaryDirection } from '@/types/database';

/**
 * The small vocabulary the payroll screens share.
 *
 * Three screens show the same month, the same status and the same signed
 * amount, and if each spelled them itself they would drift within a week.
 */

/** The three payroll screens, as one control. */
export function PayrollTabs() {
  const { t } = useI18n();
  const pathname = usePathname();

  const tabs = [
    { href: '/payroll', label: t.payroll.tabsCycles },
    { href: '/payroll/employees', label: t.payroll.tabsPeople },
    { href: '/payroll/settings', label: t.payroll.settings },
  ];

  return (
    <nav
      aria-label={t.payroll.title}
      className="mb-4 flex w-fit max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-border bg-surface-2 p-0.5"
    >
      {tabs.map((tab) => {
        // Exact match for the root, prefix for the rest: /payroll/employees
        // must not light up the cycles tab as well.
        const active = tab.href === '/payroll'
          ? pathname === '/payroll'
          : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cx(
              'rounded-full px-4 py-1.5 text-xs font-medium whitespace-nowrap',
              'transition-[background-color,color,box-shadow] duration-150 ease-soft',
              active
                ? 'bg-surface text-brand shadow-card'
                : 'text-ink-muted hover:text-ink',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

const STATUS_TONE: Record<PayrollStatus, 'neutral' | 'warn' | 'brand' | 'ok'> = {
  draft: 'neutral',
  review: 'warn',
  approved: 'brand',
  closed: 'ok',
};

export function useStatusLabel(): (status: PayrollStatus) => string {
  const { t } = useI18n();
  return (status) => ({
    draft: t.payroll.statusDraft,
    review: t.payroll.statusReview,
    approved: t.payroll.statusApproved,
    closed: t.payroll.statusClosed,
  }[status]);
}

export function StatusPill({ status }: { status: PayrollStatus }) {
  const label = useStatusLabel();
  return <Badge tone={STATUS_TONE[status]}>{label(status)}</Badge>;
}

/**
 * Where the cycle is, as four steps rather than one word.
 *
 * A status badge says where you are; it does not say what is left. Payroll is
 * the one place in this app with a real sequence, so the sequence is drawn.
 */
export function FlowTrack({ status }: { status: PayrollStatus }) {
  const label = useStatusLabel();
  const at = PAYROLL_FLOW.indexOf(status);

  return (
    <ol className="flex items-center gap-1.5" aria-label={label(status)}>
      {PAYROLL_FLOW.map((step, i) => (
        <li key={step} className="flex items-center gap-1.5">
          <span
            title={label(step)}
            className={cx(
              'block h-1.5 rounded-full transition-colors duration-200',
              i === at ? 'w-6' : 'w-3',
              i < at && 'bg-ok/60',
              i === at && (step === 'closed' ? 'bg-ok' : 'brand-ramp'),
              i > at && 'bg-border-strong',
            )}
          />
        </li>
      ))}
    </ol>
  );
}

/** The month a cycle is for, always spelled the same way. */
export function MonthName({ value }: { value: string }) {
  const { locale } = useI18n();
  return <span>{monthLabel(value, locale)}</span>;
}

/**
 * An amount with its sign made visible.
 *
 * A payslip is a column of numbers that pull in opposite directions, and a
 * deduction that looks exactly like a bonus is a payslip nobody can check at
 * a glance. The sign is drawn, not just coloured, so it survives being
 * printed in black and white.
 */
export function SignedAmount({
  amount, direction,
}: { amount: number; direction: SalaryDirection }) {
  const { locale } = useI18n();
  const earning = direction === 'earning';
  return (
    <span className={cx('tnum whitespace-nowrap', earning ? 'text-ok' : 'text-danger')}>
      {earning ? '+' : '−'}
      {formatMoney(Math.abs(Number(amount ?? 0)), locale)}
    </span>
  );
}

export function DirectionBadge({ direction }: { direction: SalaryDirection }) {
  const { t } = useI18n();
  return direction === 'earning'
    ? <Badge tone="ok">{t.payroll.earning}</Badge>
    : <Badge tone="danger">{t.payroll.deduction}</Badge>;
}

/**
 * Turns a refusal the database named into a sentence in the reader's language.
 *
 * `pay_payslip` answers `{ok:false, reason:'not_approved'}` rather than
 * raising, precisely so this can happen — a payroll screen should never show
 * a raw Postgres message to somebody about to move money.
 */
export function usePayrollReason(): (reason: string | undefined) => string {
  const { t } = useI18n();
  return (reason) => ({
    not_found: t.payroll.reasonNotFound,
    already_paid: t.payroll.reasonAlreadyPaid,
    not_approved: t.payroll.reasonNotApproved,
    nothing_to_pay: t.payroll.reasonNothingToPay,
    no_wallet: t.payroll.reasonNoWallet,
    not_paid: t.payroll.reasonNotPaid,
  }[reason ?? ''] ?? t.common.error);
}
