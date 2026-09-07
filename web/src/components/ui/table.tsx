'use client';

import type { ReactNode } from 'react';
import { cx, EmptyState, ErrorState, Skeleton } from './primitives';

export type Column<T> = {
  key: string;
  header: string;
  /** Right-align and use tabular figures. Set for every money/count column. */
  numeric?: boolean;
  render: (row: T) => ReactNode;
};

/**
 * The table scrolls inside its own container rather than widening the page:
 * on a phone a payments table is far wider than the viewport, and a
 * horizontally scrolling <body> makes the whole dashboard feel broken.
 *
 * The header stays put while the body scrolls, so a long ledger never leaves
 * you guessing which column a number belongs to.
 */
export function DataTable<T>({
  columns, rows, keyOf, loading, error, emptyMessage, loadingMessage, errorMessage, emptyAction,
  loadingRows = 5,
}: {
  columns: Array<Column<T>>;
  rows: T[];
  keyOf: (row: T, index: number) => string;
  loading?: boolean;
  error?: string | null;
  emptyMessage: string;
  loadingMessage: string;
  errorMessage: string;
  emptyAction?: ReactNode;
  /** How many placeholder rows to draw while loading. */
  loadingRows?: number;
}) {
  if (error) return <ErrorState message={errorMessage} detail={error} />;
  if (!loading && rows.length === 0) {
    return <EmptyState message={emptyMessage} action={emptyAction} />;
  }

  // While loading, the real header renders and the body is placeholder rows of
  // the same shape. The reader learns the columns immediately and nothing
  // shifts when the data lands — which a centred spinner cannot manage.
  return (
    <div
      className="overflow-x-auto overflow-y-visible rounded-b-card"
      aria-busy={loading || undefined}
    >
      {loading && <span className="sr-only">{loadingMessage}</span>}
      <table className="w-full min-w-max border-collapse text-sm">
        <thead className="sticky top-0 z-10">
          <tr className="bg-surface-2/80 backdrop-blur">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cx(
                  'border-b border-border px-4 py-3 text-xs font-semibold whitespace-nowrap text-ink-muted',
                  c.numeric ? 'text-end' : 'text-start',
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: loadingRows }, (_, r) => (
              <tr key={`skeleton-${r}`} className="border-b border-border/60 last:border-0">
                {columns.map((c, i) => (
                  <td key={c.key} className="px-4 py-3">
                    <Skeleton
                      className={cx(
                        'h-3.5',
                        c.numeric ? 'ms-auto w-16' : i === 0 ? 'w-40' : 'w-24',
                      )}
                    />
                  </td>
                ))}
              </tr>
            ))
            : rows.map((row, i) => (
            <tr
              key={keyOf(row, i)}
              className="border-b border-border/60 transition-colors duration-100 last:border-0 hover:bg-surface-2/70"
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cx(
                    'px-4 py-3 align-middle',
                    c.numeric ? 'text-end tnum' : 'text-start',
                  )}
                >
                  {c.render(row)}
                </td>
              ))}
            </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
