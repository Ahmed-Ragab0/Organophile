'use client';

import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  dictionaries, dirFor, LOCALE_COOKIE, type Dict, type Locale,
} from './dictionaries';

type I18nValue = {
  locale: Locale;
  dir: 'rtl' | 'ltr';
  t: Dict;
  setLocale: (next: Locale) => void;
  toggleLocale: () => void;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const router = useRouter();

  const setLocale = useCallback(
    (next: Locale) => {
      // The <html dir> attribute is rendered on the server from this cookie, so
      // the switch has to round-trip rather than just flipping client state.
      document.cookie =
        `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
      router.refresh();
    },
    [router],
  );

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      dir: dirFor(locale),
      t: dictionaries[locale],
      setLocale,
      toggleLocale: () => setLocale(locale === 'ar' ? 'en' : 'ar'),
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}
