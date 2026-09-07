import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans_Arabic, Readex_Pro } from 'next/font/google';
import { getLocale } from '@/lib/i18n/server';
import { dirFor } from '@/lib/i18n/dictionaries';
import { I18nProvider } from '@/lib/i18n/context';
import { getMode } from '@/lib/mode/server';
import { ModeProvider } from '@/lib/mode/context';
import { getTheme } from '@/lib/theme/server';
import { ThemeProvider } from '@/lib/theme/context';
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
  title: 'Organophile — نظام الإدارة',
  description:
    'نظام إدارة الطلاب والكورسات والاشتراكات والحسابات، متصل بيوكيرا وكاشير.',
  robots: { index: false, follow: false },
};

const CANVAS = { light: '#faf8fd', dark: '#100a18' } as const;

/**
 * The browser chrome has to follow the PINNED theme, not the machine's.
 *
 * A static `themeColor` can only branch on `prefers-color-scheme`, so someone
 * running the dashboard pinned to dark on a light laptop would get a white
 * status bar above a near-black page. Reading the same cookie the CSS reads
 * keeps the two in step.
 */
export async function generateViewport(): Promise<Viewport> {
  const theme = await getTheme();

  return {
    width: 'device-width',
    initialScale: 1,
    themeColor: theme === 'system'
      ? [
        { media: '(prefers-color-scheme: light)', color: CANVAS.light },
        { media: '(prefers-color-scheme: dark)', color: CANVAS.dark },
      ]
      : CANVAS[theme],
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [locale, mode, theme] = await Promise.all([getLocale(), getMode(), getTheme()]);

  return (
    <html
      lang={locale}
      dir={dirFor(locale)}
      // Rendered on the server from the cookie. 'system' sets nothing, which
      // is what leaves `color-scheme: light dark` free to follow the machine.
      data-theme={theme === 'system' ? undefined : theme}
      className={`${display.variable} ${sans.variable}`}
    >
      <body className="min-h-dvh font-sans antialiased">
        <I18nProvider locale={locale}>
          <ModeProvider mode={mode}>
            <ThemeProvider theme={theme}>{children}</ThemeProvider>
          </ModeProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
