import type { Locale } from './i18n/dictionaries';

/**
 * All money in this system is EGP in major units (100 = 100 EGP), matching what
 * Kashier sends. Formatting is locale-aware but the currency never changes.
 *
 * Arabic uses Latin digits deliberately: the numbers here are reconciled by eye
 * against the Kashier dashboard, which renders Latin digits.
 */
const localeTag = (locale: Locale) => (locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB');

export function formatMoney(
  value: number | null | undefined,
  locale: Locale,
  currency = 'EGP',
): string {
  const n = typeof value === 'number' ? value : 0;
  return new Intl.NumberFormat(localeTag(locale), {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
  }).format(n);
}

export function formatNumber(value: number | null | undefined, locale: Locale): string {
  return new Intl.NumberFormat(localeTag(locale)).format(
    typeof value === 'number' ? value : 0,
  );
}

/**
 * Africa/Cairo throughout. The database aggregates revenue by Cairo day, so the
 * UI must not silently shift a payment into a different day in another zone.
 */
const TZ = 'Africa/Cairo';

export function formatDate(value: string | null | undefined, locale: Locale): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(localeTag(locale), {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: TZ,
  }).format(d);
}

export function formatDateTime(value: string | null | undefined, locale: Locale): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(localeTag(locale), {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: TZ,
  }).format(d);
}

/** YYYY-MM-DD in Cairo — for date inputs and CSV, never for display. */
export function toCairoDateKey(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ,
  }).format(d);
}

export function formatShortDay(value: string | null | undefined, locale: Locale): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(localeTag(locale), {
    month: 'short', day: 'numeric', timeZone: TZ,
  }).format(d);
}

/**
 * RFC 4180 CSV with a UTF-8 BOM.
 *
 * The BOM is not decoration: without it Excel on Windows opens a UTF-8 file as
 * cp1256 and every Arabic student name turns to mojibake.
 */
export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const escape = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    columns.join(','),
    ...rows.map((row) => columns.map((c) => escape(row[c])).join(',')),
  ];
  return `﻿${lines.join('\r\n')}`;
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
