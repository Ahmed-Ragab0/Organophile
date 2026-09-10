import type { Locale } from './i18n/dictionaries';

/**
 * The amount, written out — تفقيط.
 *
 * Every payslip and receipt printed in Egypt carries the figure twice: once in
 * digits and once in words. The words are what make it a document rather than
 * a printout, because a digit can be altered after signing and a sentence
 * cannot. This is the one place in the app where numbers are NOT rendered in
 * Latin digits — a written-out amount has no digits at all.
 *
 * Arabic number grammar is not decoration here, it is correctness: the same
 * quantity takes four different forms depending on how many there are, and a
 * receipt reading "٣ ألف" instead of "ثلاثة آلاف" is a receipt that looks
 * wrong to everyone who reads it.
 */

const ONES = [
  '', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة',
  'ستة', 'سبعة', 'ثمانية', 'تسعة',
];

const TEENS = [
  'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر',
  'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر',
];

const TENS = [
  '', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون',
  'ستون', 'سبعون', 'ثمانون', 'تسعون',
];

const HUNDREDS = [
  '', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة',
  'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة',
];

/**
 * Each scale in its four forms: one, two, three-to-ten, and eleven-and-up.
 *
 * Arabic counts differently in each band — "ألف" alone, "ألفان" for two,
 * "آلاف" after 3–10, and back to the singular in the accusative after 11.
 * Collapsing these into one word is the single most common mistake in a
 * generated Arabic receipt.
 */
const SCALES: Array<[one: string, two: string, few: string, many: string]> = [
  ['', '', '', ''],
  ['ألف', 'ألفان', 'آلاف', 'ألفًا'],
  ['مليون', 'مليونان', 'ملايين', 'مليونًا'],
  ['مليار', 'ملياران', 'مليارات', 'مليارًا'],
];

/** 1–999, in the Arabic order: units before tens. */
function underThousand(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;

  if (hundreds > 0) parts.push(HUNDREDS[hundreds]);

  if (rest >= 10 && rest < 20) {
    parts.push(TEENS[rest - 10]);
  } else {
    const tens = Math.floor(rest / 10);
    const ones = rest % 10;
    // "خمسة وعشرون", not "عشرون وخمسة": the unit leads.
    if (ones > 0 && tens > 0) parts.push(`${ONES[ones]} و${TENS[tens]}`);
    else if (ones > 0) parts.push(ONES[ones]);
    else if (tens > 0) parts.push(TENS[tens]);
  }

  return parts.join(' و');
}

function arabicWholeWords(value: number): string {
  if (value === 0) return 'صفر';

  const groups: number[] = [];
  let left = value;
  while (left > 0) {
    groups.push(left % 1000);
    left = Math.floor(left / 1000);
  }

  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const g = groups[i];
    if (g === 0) continue;
    const scale = SCALES[i] ?? SCALES[SCALES.length - 1];

    if (i === 0) {
      parts.push(underThousand(g));
      continue;
    }

    /*
     * Which form the scale word takes is decided by the LAST TWO DIGITS of
     * the count, not by the count itself. 100 thousand is "مائة ألف" — back
     * to the singular — while 25 thousand is "خمسة وعشرون ألفًا". Reading the
     * whole number here instead is what produces "مائة ألفًا", which is the
     * telltale sign of a generated receipt.
     */
    const band = g % 100;
    if (g === 1) parts.push(scale[0]);
    else if (g === 2) parts.push(scale[1]);
    else if (band === 0) parts.push(`${underThousand(g).replace(/مائتان$/, 'مائتا')} ${scale[0]}`);
    else if (band === 1) parts.push(`${underThousand(g)} ${scale[0]}`);
    else if (band === 2) parts.push(`${underThousand(g)} ${scale[1]}`);
    else if (band <= 10) parts.push(`${underThousand(g)} ${scale[2]}`);
    else parts.push(`${underThousand(g)} ${scale[3]}`);
  }

  return parts.join(' و');
}

const EN_ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const EN_TENS = [
  '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
];
const EN_SCALES = ['', ' thousand', ' million', ' billion'];

function englishUnderThousand(n: number): string {
  if (n < 20) return EN_ONES[n];
  if (n < 100) {
    const t = EN_TENS[Math.floor(n / 10)];
    const o = n % 10;
    return o === 0 ? t : `${t}-${EN_ONES[o]}`;
  }
  const h = `${EN_ONES[Math.floor(n / 100)]} hundred`;
  const rest = n % 100;
  return rest === 0 ? h : `${h} and ${englishUnderThousand(rest)}`;
}

function englishWholeWords(value: number): string {
  if (value === 0) return 'zero';

  const groups: number[] = [];
  let left = value;
  while (left > 0) {
    groups.push(left % 1000);
    left = Math.floor(left / 1000);
  }

  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    if (groups[i] === 0) continue;
    parts.push(englishUnderThousand(groups[i]) + (EN_SCALES[i] ?? ''));
  }
  return parts.join(' ');
}

/**
 * An EGP amount as a sentence, for the printed payslip.
 *
 * Rounded to the piastre first: a stray floating-point tail must never reach
 * the words, because "and zero point zero one piastres" on a receipt is worse
 * than the rounding it was trying to be honest about.
 */
export function moneyInWords(amount: number, locale: Locale): string {
  const safe = Number.isFinite(amount) ? Math.abs(amount) : 0;
  const totalPiastres = Math.round(safe * 100);
  const pounds = Math.floor(totalPiastres / 100);
  const piastres = totalPiastres % 100;

  // The currency word belongs to the pounds, so the piastres clause comes
  // AFTER it: "…ألف جنيهًا وخمسون قرشًا", never "…ألف وخمسون قرشًا جنيهًا".
  if (locale === 'en') {
    const head = `${englishWholeWords(pounds)} Egyptian pounds`;
    const tail = piastres > 0 ? ` and ${englishWholeWords(piastres)} piastres` : '';
    return `${head}${tail} only`;
  }

  const head = `${arabicWholeWords(pounds)} جنيهًا مصريًا`;
  const tail = piastres > 0 ? ` و${arabicWholeWords(piastres)} قرشًا` : '';
  return `فقط ${head}${tail} لا غير`;
}
