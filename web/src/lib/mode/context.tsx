'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_MODE, MODE_COOKIE, type Mode } from './mode';

type ModeValue = {
  mode: Mode;
  isTest: boolean;
  setMode: (next: Mode) => void;
};

const ModeContext = createContext<ModeValue | null>(null);

export function ModeProvider({ mode: initial, children }: { mode: Mode; children: ReactNode }) {
  // Unlike the locale, switching mode changes no server-rendered attribute, so
  // it does not need a round trip. State updates immediately and the cookie is
  // written alongside it so the next full load agrees.
  const [mode, setModeState] = useState<Mode>(initial ?? DEFAULT_MODE);

  const setMode = useCallback((next: Mode) => {
    document.cookie = `${MODE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    setModeState(next);
  }, []);

  const value = useMemo<ModeValue>(
    () => ({ mode, isTest: mode === 'test', setMode }),
    [mode, setMode],
  );

  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export function useMode(): ModeValue {
  const ctx = useContext(ModeContext);
  if (!ctx) throw new Error('useMode must be used inside <ModeProvider>');
  return ctx;
}
