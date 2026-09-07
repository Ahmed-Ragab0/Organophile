/**
 * Column auto-detection for ukkera CSV exports.
 *
 * The exact export headers are not confirmed yet, and they may be Arabic,
 * English, or a mix. Rather than hardcoding one guess, each system field lists
 * the header spellings seen in the wild; anything unmatched is left for the
 * operator to map by hand in the UI.
 */

export type StudentField =
  | 'name' | 'phone' | 'ukkera_student_id' | 'group_name' | 'university' | 'email';

export type TransactionField = 'order_id' | 'amount';

const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[ً-ْ]/g, '') // strip Arabic diacritics
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[_\-\s]+/g, '');

const STUDENT_ALIASES: Record<StudentField, string[]> = {
  name: ['name', 'studentname', 'fullname', 'الاسم', 'اسمالطالب', 'الطالب', 'اسم'],
  phone: ['phone', 'mobile', 'phonenumber', 'whatsapp', 'الموبايل', 'الهاتف', 'رقمالهاتف', 'التليفون', 'رقمالموبايل'],
  ukkera_student_id: ['id', 'studentid', 'ukkeraid', 'code', 'الكود', 'رقمالطالب', 'المعرف'],
  group_name: ['group', 'groupname', 'class', 'المجموعه', 'الجروب', 'الفصل'],
  university: ['university', 'college', 'faculty', 'الجامعه', 'الكليه'],
  email: ['email', 'mail', 'البريد', 'الايميل', 'البريدالالكتروني'],
};

const TRANSACTION_ALIASES: Record<TransactionField, string[]> = {
  order_id: ['orderid', 'order', 'ordernumber', 'reference', 'رقمالطلب', 'الطلب', 'المرجع'],
  amount: ['amount', 'total', 'price', 'paid', 'المبلغ', 'الاجمالي', 'السعر', 'المدفوع'],
};

function guess(headers: string[], aliases: string[]): string {
  const normalized = headers.map((h) => ({ raw: h, n: norm(h) }));
  // Exact alias match first, then a contains match, so 'phone' does not lose to
  // 'phone_verified' just because it appears later in the file.
  for (const alias of aliases) {
    const exact = normalized.find((h) => h.n === alias);
    if (exact) return exact.raw;
  }
  for (const alias of aliases) {
    const partial = normalized.find((h) => h.n.includes(alias));
    if (partial) return partial.raw;
  }
  return '';
}

export function guessStudentMapping(headers: string[]): Record<StudentField, string> {
  return Object.fromEntries(
    (Object.keys(STUDENT_ALIASES) as StudentField[]).map((f) => [f, guess(headers, STUDENT_ALIASES[f])]),
  ) as Record<StudentField, string>;
}

export function guessTransactionMapping(headers: string[]): Record<TransactionField, string> {
  return Object.fromEntries(
    (Object.keys(TRANSACTION_ALIASES) as TransactionField[]).map((f) => [f, guess(headers, TRANSACTION_ALIASES[f])]),
  ) as Record<TransactionField, string>;
}

/** Projects raw CSV rows onto system field names, dropping unmapped columns. */
export function applyMapping<F extends string>(
  rows: Array<Record<string, unknown>>,
  mapping: Record<F, string>,
): Array<Record<F, string>> {
  const pairs = (Object.entries(mapping) as Array<[F, string]>).filter(([, col]) => col !== '');
  return rows.map((row) => {
    const out = {} as Record<F, string>;
    for (const [field, col] of pairs) {
      const value = row[col];
      out[field] = value === null || value === undefined ? '' : String(value).trim();
    }
    return out;
  });
}

export const STUDENT_FIELDS = Object.keys(STUDENT_ALIASES) as StudentField[];
export const TRANSACTION_FIELDS = Object.keys(TRANSACTION_ALIASES) as TransactionField[];
