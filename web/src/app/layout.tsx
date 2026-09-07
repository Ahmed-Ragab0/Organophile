import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans_Arabic } from 'next/font/google';
import { getLocale } from '@/lib/i18n/server';
import { dirFor } from '@/lib/i18n/dictionaries';
import { I18nProvider } from '@/lib/i18n/context';
import './globals.css';

/**
 * One family covering both scripts keeps Arabic and Latin at the same optical
 * weight, so a bilingual table does not look like two different documents.
 */
const appSans = IBM_Plex_Sans_Arabic({
  subsets: ['arabic', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-app-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Organophile — Students & Payments',
  description: 'Students, subscriptions, payments and payouts dashboard.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();

  return (
    <html lang={locale} dir={dirFor(locale)} className={appSans.variable}>
      <body className="min-h-dvh font-sans antialiased">
        <I18nProvider locale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
