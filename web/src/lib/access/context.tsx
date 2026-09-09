'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

/** What `public.my_access()` answers. */
export type Access = {
  is_staff: boolean;
  user_id?: string;
  email?: string;
  full_name?: string | null;
  role?: {
    id: string;
    code: string;
    name: string;
    name_en: string | null;
    is_superuser: boolean;
  };
  permissions: string[];
};

export const NO_ACCESS: Access = { is_staff: false, permissions: [] };

type AccessValue = Access & {
  /** Whether the signed-in person holds this permission. */
  can: (permission: string) => boolean;
};

const AccessContext = createContext<AccessValue | null>(null);

/**
 * What the signed-in person may do, read once on the server and handed down.
 *
 * Fetched in the layout rather than by each page: a permission check that
 * arrives after the first paint shows every button for a moment and then takes
 * half of them away, which reads as a bug even though nothing was ever
 * clickable.
 *
 * This decides what is RENDERED and nothing else. The database refuses the same
 * things through RLS whatever this says — hiding a button someone cannot use is
 * courtesy, not security.
 */
export function AccessProvider({ access, children }: { access: Access; children: ReactNode }) {
  const value = useMemo<AccessValue>(() => {
    const held = new Set(access.permissions ?? []);
    return { ...access, can: (permission: string) => held.has(permission) };
  }, [access]);

  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

export function useAccess(): AccessValue {
  const ctx = useContext(AccessContext);
  if (!ctx) throw new Error('useAccess must be used inside <AccessProvider>');
  return ctx;
}
