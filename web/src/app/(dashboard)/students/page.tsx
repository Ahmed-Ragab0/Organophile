'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { downloadCsv, formatDate, toCsv } from '@/lib/format';
import { Button, Card, CardHeader, Field, Input, PageHeader } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/table';
import type { Student } from '@/types/database';

export default function StudentsPage() {
  const { t, locale } = useI18n();
  const [search, setSearch] = useState('');

  const { data, loading, error } = useSupabaseQuery<Student[]>(
    (sb) => {
      let q = sb.from('students').select('*').order('created_at', { ascending: false }).limit(500);
      if (search.trim()) {
        const s = search.trim();
        q = q.or(`name.ilike.%${s}%,phone.ilike.%${s}%,group_name.ilike.%${s}%,university.ilike.%${s}%`);
      }
      return q;
    },
    [search],
  );

  const rows = data ?? [];

  const columns: Array<Column<Student>> = [
    { key: 'name', header: t.students.name, render: (r) => <span className="font-medium text-ink">{r.name}</span> },
    {
      key: 'phone',
      header: t.students.phone,
      render: (r) => r.phone ? <span className="ltr-id text-xs">{r.phone}</span> : <span className="text-ink-faint">—</span>,
    },
    { key: 'group', header: t.students.group, render: (r) => r.group_name ?? <span className="text-ink-faint">—</span> },
    { key: 'university', header: t.students.university, render: (r) => r.university ?? <span className="text-ink-faint">—</span> },
    {
      key: 'created',
      header: t.students.createdAt,
      render: (r) => <span className="text-xs text-ink-muted">{formatDate(r.created_at, locale)}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title={t.students.title}
        subtitle={t.students.subtitle}
        action={
          <Button
            variant="secondary"
            onClick={() =>
              downloadCsv(
                `students-${new Date().toISOString().slice(0, 10)}.csv`,
                toCsv(rows, ['name', 'phone', 'group_name', 'university', 'email', 'ukkera_student_id', 'created_at']),
              )}
          >
            {t.common.export}
          </Button>
        }
      />

      <Card className="mb-4 p-4">
        <div className="max-w-sm">
          <Field label={t.common.search}>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="…" />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title={t.students.title} hint={`${rows.length} ${t.common.rows}`} />
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
