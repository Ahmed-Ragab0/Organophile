import type { Locale } from './i18n/dictionaries';
import { formatDate } from './format';
import type { PayslipRow } from '@/types/database';

/**
 * The parts of payroll that are neither database nor screen: what the
 * thank-you message says, and how it reaches somebody.
 */

/**
 * The month, named.
 *
 * Built from the 'YYYY-MM-DD' string rather than from a Date, because
 * `new Date('2026-09-01')` is UTC midnight and any timezone west of Greenwich
 * renders it as August. A payslip that says the wrong month is not a small bug.
 */
export function monthLabel(periodMonth: string, locale: Locale): string {
  const [y, m] = periodMonth.split('-').map(Number);
  if (!y || !m) return periodMonth;
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** Just the month name, for the {month} variable that has {year} beside it. */
export function monthName(periodMonth: string, locale: Locale): string {
  const [y, m] = periodMonth.split('-').map(Number);
  if (!y || !m) return periodMonth;
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
    month: 'long', timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/**
 * Every placeholder the message understands, in the order they are offered.
 *
 * The list is the contract: it is what the chips on the editor render from and
 * what `messageVariables` fills, so a variable cannot exist in one and not the
 * other. `{bonus}` is every earning that is not a commission, which is what
 * makes the arithmetic in the message close:
 *
 *     baseSalary + commissions + bonus − deductions = net
 */
export const MESSAGE_VARIABLES = [
  'name', 'role', 'month', 'year', 'net', 'gross', 'baseSalary',
  'commissions', 'bonus', 'deductions', 'paidDate', 'paidWallet', 'company',
] as const;

export type MessageVariable = (typeof MESSAGE_VARIABLES)[number];

/**
 * The message as it ships.
 *
 * The same text 0049 seeds the settings row with. Two copies of one string is
 * normally a drift risk; here it is not, because the seed runs once and this
 * one only ever comes back through the "reset to default" button — they have
 * to agree on that day and on no other.
 */
export const DEFAULT_THANKS_TEMPLATE = [
  'جزاك الله خيرًا يا {name} 🌟',
  'نشكرك على جهودك ومثابرتك في {company}.',
  '',
  'راتبك عن شهر {month} {year} وقدره {net} جنيه قد تم صرفه بتاريخ {paidDate} عبر {paidWallet}.',
  '',
  'نسأل الله أن يبارك لك فيه ويزيدك من فضله 🤲',
].join('\n');

/**
 * An amount with no currency on it.
 *
 * The template already writes the word — "وقدره {net} جنيه" — so the variable
 * must not carry one too. Stripping the symbol off a formatted currency string
 * is not the way: Arabic renders EGP as "ج.م." and the two full stops in it
 * survive any digits-and-punctuation filter, which is how "6,600" becomes
 * "6,600..".
 */
function bareAmount(value: number, locale: Locale): string {
  const n = Number(value ?? 0);
  return new Intl.NumberFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
    style: 'decimal',
    maximumFractionDigits: 2,
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
  }).format(n);
}

export function messageVariables(
  slip: PayslipRow,
  company: string,
  locale: Locale,
  fallbackWallet?: string | null,
): Record<MessageVariable, string> {
  const money = (n: number) => bareAmount(n, locale);

  return {
    name: slip.employee_name,
    role: slip.job_title ?? '',
    month: monthName(slip.period_month, locale),
    year: slip.period_month.slice(0, 4),
    net: money(slip.net_amount),
    gross: money(slip.gross_amount),
    baseSalary: money(slip.base_salary),
    commissions: money(slip.commissions_total),
    bonus: money(slip.bonus_total),
    deductions: money(slip.deductions_total),
    // Before it is paid the message is a preview, so today stands in for the
    // date it will carry. Never blank: a preview with a hole in it reads as
    // broken rather than as unfinished.
    paidDate: formatDate(slip.paid_at ?? new Date().toISOString(), locale),
    paidWallet: slip.paid_wallet_name ?? fallbackWallet ?? '',
    company,
  };
}

/**
 * Fill the placeholders.
 *
 * An unknown `{placeholder}` is left standing rather than blanked, because a
 * typo that disappears silently is a typo that gets sent. Seeing `{nmae}` in
 * the preview is the fastest possible bug report.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole);
}

/**
 * An Egyptian number in the form wa.me wants: country code, no plus, no zero.
 *
 * The same person's number is written 01012345678, +20 10 1234 5678, and
 * 0020101234567 in three different places, and none of them is wrong. Returns
 * null when there is nothing dialable, so the caller can hide the button
 * rather than open WhatsApp on a broken link.
 */
export function whatsappNumber(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < 8) return null;

  // 00 20 … — the international prefix spelled the old way.
  const noPrefix = digits.startsWith('00') ? digits.slice(2) : digits;
  if (noPrefix.startsWith('20')) return noPrefix;
  // 01012345678 — the way it is written on every Egyptian phone.
  if (noPrefix.startsWith('0')) return `20${noPrefix.slice(1)}`;
  // 1012345678 — the same number with the trunk zero already gone.
  if (noPrefix.startsWith('1') && noPrefix.length === 10) return `20${noPrefix}`;
  return noPrefix;
}

/** A wa.me link that opens the chat with the message already typed. */
export function whatsappLink(
  phone: string | null | undefined,
  text: string,
): string | null {
  const number = whatsappNumber(phone);
  if (number === null) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

/** The four states a cycle moves through, in order, for progress and pills. */
export const PAYROLL_FLOW = ['draft', 'review', 'approved', 'closed'] as const;
