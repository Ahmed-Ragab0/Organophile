'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { formatDate, formatMoney } from '@/lib/format';
import { monthLabel } from '@/lib/payroll';
import { moneyInWords } from '@/lib/number-words';
import { Button, ErrorState, Spinner } from '@/components/ui/primitives';
import type { PayrollSettingsRow, PayslipRow } from '@/types/database';

/**
 * The payslip as a document.
 *
 * This route sits OUTSIDE the dashboard shell on purpose: it is a sheet of
 * paper, and a sheet of paper does not have a sidebar. The middleware still
 * gates it on `payroll.read` and RLS still refuses the row, so being outside
 * the shell costs nothing in access — see `ROUTE_PERMISSIONS['/payslip']`.
 *
 * PDF comes from the browser's own print dialog rather than from a library.
 * That is not a shortcut: Arabic needs contextual letter shaping and
 * right-to-left runs, and the client-side PDF libraries either get that wrong
 * or need a shaping engine and an embedded font shipped to every visitor. The
 * browser already has both, renders exactly what is on screen, and adds
 * nothing to the bundle.
 */
export default function PayslipDocumentPage() {
  const { t, locale } = useI18n();
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const slip = useSupabaseQuery<PayslipRow>(
    (sb) => sb.from('v_payslips').select('*').eq('id', id ?? '').single(),
    [id ?? ''],
  );
  const settings = useSupabaseQuery<PayrollSettingsRow>(
    (sb) => sb.from('payroll_settings').select('*').limit(1).single(), [],
  );

  if (slip.loading) {
    return (
      <main className="mx-auto max-w-3xl px-5 py-12">
        <Spinner label={t.common.loading} />
      </main>
    );
  }
  if (slip.error || !slip.data) {
    return (
      <main className="mx-auto max-w-3xl px-5 py-12">
        <ErrorState message={t.common.error} detail={slip.error ?? undefined} />
      </main>
    );
  }

  const s = slip.data;
  const company = settings.data?.company_name ?? '';
  const earnings = s.items.filter((i) => i.direction === 'earning');
  const deductions = s.items.filter((i) => i.direction === 'deduction');

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
      <div className="print-hide mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/payroll"
          className="text-sm text-ink-muted underline-offset-2 hover:text-ink hover:underline"
        >
          ← {t.payroll.backToPayroll}
        </Link>
        <span className="flex items-center gap-3">
          <span className="text-xs text-ink-faint">{t.payroll.printHint}</span>
          <Button onClick={() => window.print()}>{t.payroll.print}</Button>
        </span>
      </div>

      <article className="print-sheet rounded-panel border border-border bg-surface p-6 shadow-card sm:p-10">
        {/* ---------------------------------------------------------- head */}
        <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-brand-strong pb-5">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="brand-ramp flex h-12 w-12 shrink-0 items-center justify-center rounded-tile"
            >
              <Image
                src="/logo-mark.png"
                alt=""
                width={96}
                height={96}
                className="h-[70%] w-[70%] object-contain"
              />
            </span>
            <div>
              <p className="font-display text-lg font-semibold text-ink display-tight">{company}</p>
              <p className="mt-0.5 text-xs text-ink-muted">{t.common.appName}</p>
            </div>
          </div>

          <div className="text-end">
            <h1 className="font-display text-xl font-semibold text-brand-strong display-tight">
              {t.payroll.payslipTitle}
            </h1>
            <p className="mt-1 text-sm font-medium text-ink">
              {monthLabel(s.period_month, locale)}
            </p>
          </div>
        </header>

        {/* --------------------------------------------------------- meta */}
        <section className="grid gap-x-8 gap-y-3 border-b border-border py-5 sm:grid-cols-2">
          <Line label={t.payroll.employee} value={s.employee_name} strong />
          <Line
            label={t.payroll.payslipNo}
            /* The first block of the UUID: short enough to say out loud, long
               enough to find the row, and it needs no counter of its own. */
            value={<span dir="ltr" className="font-mono text-xs uppercase">{s.id.slice(0, 8)}</span>}
          />
          <Line label={t.payroll.jobTitle} value={s.job_title ?? '—'} />
          <Line label={t.payroll.issuedAt} value={formatDate(s.created_at, locale)} />
          {s.phone && (
            <Line
              label={t.payroll.phone}
              value={<span dir="ltr" className="tnum">{s.phone}</span>}
            />
          )}
          <Line label={t.payroll.forMonth} value={monthLabel(s.period_month, locale)} />
        </section>

        {/* -------------------------------------------------------- lines */}
        <section className="py-5">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th
                  scope="col"
                  className="border-b border-border pb-2 text-start text-xs font-semibold text-ink-muted"
                >
                  {t.payroll.item}
                </th>
                <th
                  scope="col"
                  className="border-b border-border pb-2 text-end text-xs font-semibold text-ink-muted"
                >
                  {t.payroll.amount}
                </th>
              </tr>
            </thead>
            <tbody>
              <Row label={t.payroll.baseSalary} amount={s.base_salary} locale={locale} />
              {earnings.map((i) => (
                <Row key={i.id} label={i.label} amount={i.amount} locale={locale} />
              ))}

              <tr>
                <td className="border-t border-border pt-2.5 text-sm font-medium text-ink">
                  {t.payroll.totalEarnings}
                </td>
                <td className="border-t border-border pt-2.5 text-end font-display font-semibold tnum text-ink">
                  {formatMoney(s.gross_amount, locale)}
                </td>
              </tr>

              {deductions.length > 0 && (
                <>
                  <tr>
                    <td colSpan={2} className="pt-5 pb-1 text-xs font-semibold text-ink-muted">
                      {t.payroll.totalDeductions}
                    </td>
                  </tr>
                  {deductions.map((i) => (
                    <Row key={i.id} label={i.label} amount={i.amount} locale={locale} negative />
                  ))}
                  <tr>
                    <td className="border-t border-border pt-2.5 text-sm font-medium text-ink">
                      {t.payroll.totalDeductions}
                    </td>
                    <td className="border-t border-border pt-2.5 text-end font-display font-semibold tnum text-danger">
                      −{formatMoney(s.deductions_total, locale)}
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </section>

        {/* ---------------------------------------------------------- net */}
        <section className="print-keep rounded-card bg-brand-soft px-5 py-4">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <span className="font-display text-sm font-semibold text-brand-strong">
              {t.payroll.netPayable}
            </span>
            <span className="font-display text-2xl font-semibold tnum text-brand-strong display-tight">
              {formatMoney(s.net_amount, locale)}
            </span>
          </div>
          {/* The figure written out. This is the line that makes it a document
              rather than a printout: digits can be altered after signing. */}
          <p className="mt-2 border-t border-brand/20 pt-2 text-xs leading-relaxed text-brand">
            {moneyInWords(s.net_amount, locale)}
          </p>
        </section>

        {/* ------------------------------------------------------- payment */}
        <section className="mt-5 border-t border-border pt-4 text-sm">
          {s.paid_at ? (
            <div className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
              <Line label={t.payroll.paidAt} value={formatDate(s.paid_at, locale)} />
              <Line label={t.payroll.fromWallet} value={s.paid_wallet_name ?? '—'} />
            </div>
          ) : (
            <p className="rounded-field bg-warn-soft px-3.5 py-2.5 text-xs text-warn ring-1 ring-warn/20 ring-inset">
              {t.payroll.notPaidYet}
            </p>
          )}

          {s.note && <p className="mt-3 text-xs text-ink-muted">{s.note}</p>}
        </section>

        {/* ----------------------------------------------------- signatures */}
        <section className="print-keep mt-10 grid gap-8 sm:grid-cols-2">
          {[t.payroll.employeeSignature, t.payroll.approverSignature].map((label) => (
            <div key={label}>
              <div className="h-10 border-b border-dashed border-border-strong" />
              <p className="mt-1.5 text-xs text-ink-faint">{label}</p>
            </div>
          ))}
        </section>

        {settings.data?.invoice_note && (
          <footer className="mt-8 border-t border-border pt-3 text-center text-xs text-ink-faint">
            {settings.data.invoice_note}
          </footer>
        )}
      </article>
    </main>
  );
}

function Line({
  label, value, strong,
}: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 sm:justify-start sm:gap-2">
      <span className="text-xs text-ink-faint">{label}</span>
      <span className={strong ? 'font-display text-sm font-semibold text-ink' : 'text-sm text-ink'}>
        {value}
      </span>
    </div>
  );
}

function Row({
  label, amount, locale, negative,
}: {
  label: string;
  amount: number;
  locale: 'ar' | 'en';
  negative?: boolean;
}) {
  return (
    <tr>
      <td className="py-1.5 text-ink">{label}</td>
      <td className={`py-1.5 text-end tnum ${negative ? 'text-danger' : 'text-ink'}`}>
        {negative && '−'}
        {formatMoney(amount, locale)}
      </td>
    </tr>
  );
}
