'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { downloadCsv, formatDate, formatMoney, toCsv } from '@/lib/format';
import { Button, Card, CardHeader, Field, Input, PageHeader } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/table';
import { Mono } from '@/components/domain';

/**
 * Shaped by the embedded select below rather than a generated view type: the
 * PostgREST resource embedding returns nested objects, not flat columns.
 */
type SubscriptionRow = {
  id: string;
  order_id: string;
  amount: number | null;
  payment_date: string | null;
  source: string;
  created_at: string;
  students: { name: string; phone: string | null } | null;
  courses: { name: string } | null;
  packages: { name: string } | null;
};

export default function SubscriptionsPage() {
  const { t, locale } = useI18n();
  const [search, setSearch] = useState('');

  const { data, loading, error } = useSupabaseQuery<SubscriptionRow[]>(
    (sb) => {
      let q = sb
        .from('subscriptions')
        .select('id,order_id,amount,payment_date,source,created_at,students(name,phone),courses(name),packages(name)')
        .order('created_at', { ascending: false })
        .limit(500);
      if (search.trim()) q = q.ilike('order_id', `%${search.trim()}%`);
      return q as unknown as PromiseLike<{ data: SubscriptionRow[] | null; error: { message: string } | null }>;
    },
    [search],
  );

  const rows = data ?? [];

  const columns: Array<Column<SubscriptionRow>> = [
    { key: 'order', header: t.subscriptions.orderId, render: (r) => <Mono value={r.order_id} /> },
    {
      key: 'student',
      header: t.subscriptions.student,
      render: (r) => r.students?.name ?? <span className="text-ink-faint">—</span>,
    },
    { key: 'course', header: t.subscriptions.course, render: (r) => r.courses?.name ?? <span className="text-ink-faint">—</span> },
    { key: 'package', header: t.subscriptions.package, render: (r) => r.packages?.name ?? <span className="text-ink-faint">—</span> },
    {
      key: 'amount',
      header: t.subscriptions.amount,
      numeric: true,
      render: (r) => r.amount === null ? <span className="text-ink-faint">—</span> : formatMoney(r.amount, locale),
    },
    {
      key: 'date',
      header: t.subscriptions.paymentDate,
      render: (r) => <span className="text-xs text-ink-muted">{formatDate(r.payment_date ?? r.created_at, locale)}</span>,
    },
    { key: 'source', header: t.subscriptions.source, render: (r) => <span className="text-xs text-ink-faint">{r.source}</span> },
  ];

  return (
    <>
      <PageHeader
        title={t.subscriptions.title}
        subtitle={t.subscriptions.subtitle}
        action={
          <Button
            variant="secondary"
            onClick={() =>
              downloadCsv(
                `subscriptions-${new Date().toISOString().slice(0, 10)}.csv`,
                toCsv(
                  rows.map((r) => ({
                    order_id: r.order_id,
                    student: r.students?.name ?? '',
                    phone: r.students?.phone ?? '',
                    course: r.courses?.name ?? '',
                    package: r.packages?.name ?? '',
                    amount: r.amount ?? '',
                    payment_date: r.payment_date ?? '',
                    source: r.source,
                  })),
                  ['order_id', 'student', 'phone', 'course', 'package', 'amount', 'payment_date', 'source'],
                ),
              )}
          >
            {t.common.export}
          </Button>
        }
      />

      <Card className="mb-4 p-4">
        <div className="max-w-sm">
          <Field label={t.common.search}>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="YOK-…" />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title={t.subscriptions.title} hint={`${rows.length} ${t.common.rows}`} />
        <DataTable
          columns={columns}
          rows={rows}
          keyOf={(r) => r.id}
          loading={loading}
          error={error}
          emptyMessage={t.common.empty}
          loadingMessage={t.common.loading}
          errorMessage={t.common.error}
        />
      </Card>
    </>
  );
}
