'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from './supabase/client';

type QueryState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
};

type Settled<T> = { key: string; data: T | null; error: string | null };

/**
 * Minimal client-side query hook.
 *
 * `deps` is the dependency array for the query, exactly like useEffect: pass
 * every filter value the query closes over, or the table will keep showing
 * results for the previous filter.
 *
 * `loading` is DERIVED, not stored: it is simply "the settled result does not
 * belong to the current dependency key". That keeps the effect free of any
 * synchronous setState, which would otherwise trigger a cascading render on
 * every filter keystroke, and it makes an out-of-order response impossible to
 * display — a stale response carries a stale key and is ignored.
 */
export function useSupabaseQuery<T>(
  run: (
    supabase: SupabaseClient,
  ) => PromiseLike<{ data: T | null; error: { message: string } | null }>,
  deps: unknown[],
): QueryState<T> {
  const [nonce, setNonce] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);

  // Dependencies are primitives (filter values), so a delimited join is a sound
  // identity for "which query is this". Computed inline rather than memoised:
  // it is a map+join over a handful of scalars, and useMemo would need a
  // literal dependency array, which a caller-supplied `deps` cannot be.
  const depKey = deps.map((d) => (d === null || d === undefined ? '~' : String(d))).join('|');
  const requestKey = `${depKey}#${nonce}`;

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    Promise.resolve(run(createClient())).then(
      ({ data, error }) => {
        if (cancelled) return;
        setSettled({ key: requestKey, data: error ? null : data, error: error?.message ?? null });
      },
      (err: unknown) => {
        if (cancelled) return;
        setSettled({
          key: requestKey,
          data: null,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );

    return () => {
      cancelled = true;
    };
    // `run` is intentionally excluded: callers pass an inline closure, which is
    // a new reference every render and would loop forever. requestKey already
    // captures everything the query depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  const fresh = settled !== null && settled.key === requestKey;

  return {
    data: fresh ? settled.data : null,
    loading: !fresh,
    error: fresh ? settled.error : null,
    reload,
  };
}
