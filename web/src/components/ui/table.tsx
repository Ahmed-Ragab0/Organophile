'use client';

import type { ReactNode } from 'react';
import { cx, EmptyState, ErrorState, Spinner } from './primitives';

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
 */
export function DataTable<T>({
  columns, rows, keyOf, loading, error, emptyMessage, loadingMessage, errorMessage,
}: {
  columns: Array<Column<T>>;
  rows: T[];
  keyOf: (row: T, index: number) => string;
  loading?: boolean;
  error?: string | null;
  emptyMessage: string;
  loadingMessage: string;
  errorMessage: string;
}) {
  if (loading) return <Spinner label={loadingMessage} />;
  if (error) return <ErrorState message={errorMessage} detail={error} />;
  if (rows.length === 0) return <EmptyState message={emptyMessage} />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max border-collapse text-sm">
        <thead>
          <tr className="border-b border-border">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cx(
                  'whitespace-nowrap px-4 py-2.5 text-xs font-semibold text-ink-muted',
                  c.numeric ? 'text-end' : 'text-start',
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={keyOf(row, i)}
              className="border-b border-border/60 last:border-0 hover:bg-surface-2/60"
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cx(
                    'px-4 py-2.5 align-middle',
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
