'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_THEME, nextTheme, THEME_COOKIE, type Theme } from './theme';

type ThemeValue = {
  theme: Theme;
  setTheme: (next: Theme) => void;
  cycle: () => void;
};

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ theme: initial, children }: { theme: Theme; children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(initial ?? DEFAULT_THEME);

  const setTheme = useCallback((next: Theme) => {
    // The attribute is what the CSS reads; the cookie is what the server reads
    // on the next load. Both are written together so they cannot drift.
    const root = document.documentElement;
    if (next === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', next);

    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    setThemeState(next);
  }, []);

  const value = useMemo<ThemeValue>(
    () => ({ theme, setTheme, cycle: () => setTheme(nextTheme(theme)) }),
    [theme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
