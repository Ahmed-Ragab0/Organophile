import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans_Arabic, Readex_Pro } from 'next/font/google';
import { getLocale } from '@/lib/i18n/server';
import { dirFor } from '@/lib/i18n/dictionaries';
import { I18nProvider } from '@/lib/i18n/context';
import './globals.css';

/**
 * Two faces, two jobs.
 *
 * Readex Pro carries the identity: geometric, slightly wide, and drawn for
 * Arabic and Latin as one family, so a bilingual heading does not look like
 * two documents. It appears only at display sizes.
 *
 * IBM Plex Sans Arabic does the reading and the data. It has genuine tabular
 * figures, which is what keeps columns of money aligned.
 */
const display = Readex_Pro({
  subsets: ['arabic', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-app-display',
  display: 'swap',
});

const sans = IBM_Plex_Sans_Arabic({
  subsets: ['arabic', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-app-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Organophile — الطلاب والمدفوعات',
  description: 'لوحة تحكم الطلاب والاشتراكات والمدفوعات والمحافظ.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbf9fd' },
    { media: '(prefers-color-scheme: dark)', color: '#140d1c' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();

  return (
    <html lang={locale} dir={dirFor(locale)} className={`${display.variable} ${sans.variable}`}>
      <body className="min-h-dvh font-sans antialiased">
        <I18nProvider locale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
