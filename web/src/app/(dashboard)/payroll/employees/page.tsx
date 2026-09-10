'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useAccess } from '@/lib/access/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { formatDate, formatMoney } from '@/lib/format';
import { whatsappNumber } from '@/lib/payroll';
import {
  Badge, Button, Card, CardHeader, ErrorState, Notice, PageHeader, PageSkeleton,
} from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/table';
import { Money, StatCard } from '@/components/domain';
import { PayrollTabs } from '@/components/payroll/parts';
import {
  CreateRecordModal, DeleteRecordDialog, EditRecordModal, RecordActions,
  type FieldSpec,
} from '@/components/record-actions';
import type { EmployeeRow, WalletBalance } from '@/types/database';

type StaffOption = { user_id: string; email: string; full_name: string | null };

/**
 * Who is on the payroll.
 *
 * Deliberately a different list from the Staff page, and the difference is
 * worth stating on screen: that one is who may SIGN IN, this one is who gets
 * PAID. The assistant paid in cash has no login and the owner has a login and
 * no salary, so folding the two together would force every paid person to be
 * given an email and a password before they could exist.
 *
 * The link between them is optional and lives here, as one field.
 */
export default function PayrollPeoplePage() {
  const { t, locale } = useI18n();
  const { can } = useAccess();
  const mayWrite = can('payroll.write');
  const maySeeStaff = can('staff.read');

  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const people = useSupabaseQuery<EmployeeRow[]>(
    (sb) => sb.from('v_employees').select('*')
      .order('is_active', { ascending: false }).order('full_name'),
    [],
  );
  const wallets = useSupabaseQuery<WalletBalance[]>(
    (sb) => sb.from('v_wallet_balances').select('*').order('sort_order'), [],
  );
  // Only fetched when the reader may see it. A payroll clerk without
  // `staff.read` gets no options here rather than an empty select they would
  // read as "there are no accounts".
  const staff = useSupabaseQuery<StaffOption[]>(
    (sb) => (maySeeStaff
      ? sb.from('v_staff').select('user_id, email, full_name').order('email')
      : Promise.resolve({ data: [] as StaffOption[], error: null })),
    [maySeeStaff],
  );

  const rows = people.data ?? [];
  const active = rows.filter((r) => r.is_active);
  const monthly = active.reduce((s, r) => s + Number(r.base_salary ?? 0), 0);
  const editing = rows.find((r) => r.id === editingId) ?? null;

  const fields: FieldSpec[] = [
    { name: 'full_name', label: t.payroll.fullName, type: 'text', required: true },
    { name: 'job_title', label: t.payroll.jobTitleField, type: 'text' },
    { name: 'base_salary', label: t.payroll.baseSalary, type: 'number' },
    {
      name: 'phone', label: t.payroll.phone, type: 'text', hint: t.payroll.phoneHint,
    },
    { name: 'email', label: t.payroll.email, type: 'text' },
    {
      name: 'wallet_id',
      label: t.payroll.wallet,
      type: 'select',
      hint: t.payroll.walletHint,
      options: (wallets.data ?? [])
        .filter((w) => w.is_active)
        .map((w) => ({ value: w.id, label: w.name })),
    },
    { name: 'hired_on', label: t.payroll.hiredOn, type: 'date', hint: t.payroll.datesHint },
    { name: 'ended_on', label: t.payroll.endedOn, type: 'date' },
    ...(maySeeStaff
      ? [{
        name: 'user_id',
        label: t.payroll.linkAccount,
        type: 'select' as const,
        hint: t.payroll.linkHint,
        options: (staff.data ?? []).map((s) => ({
          value: s.user_id,
          label: s.full_name ? `${s.full_name} · ${s.email}` : s.email,
        })),
      }]
      : []),
    { name: 'is_active', label: t.payroll.activeLabel, type: 'checkbox' },
    { name: 'note', label: t.payroll.note, type: 'textarea' },
  ];

  const columns: Array<Column<EmployeeRow>> = [
    {
      key: 'name',
      header: t.payroll.fullName,
      render: (r) => (
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium text-ink">{r.full_name}</span>
            {!r.is_active && <Badge tone="neutral">{t.records.archived}</Badge>}
          </span>
          {r.job_title && (
            <span className="mt-0.5 block truncate text-xs text-ink-faint">{r.job_title}</span>
          )}
        </span>
      ),
    },
    {
      key: 'salary',
      header: t.payroll.baseSalary,
      numeric: true,
      render: (r) => <Money value={r.base_salary} tone="plain" />,
    },
    {
      key: 'wallet',
      header: t.payroll.wallet,
      render: (r) => (r.wallet_name
        ? <span className="text-xs text-ink-muted">{r.wallet_name}</span>
        : <span className="text-xs text-ink-faint">—</span>),
    },
    {
      key: 'phone',
      header: t.payroll.phone,
      render: (r) => (whatsappNumber(r.phone) === null
        ? <span className="text-xs text-ink-faint">—</span>
        // Latin digits and forced LTR: a phone number written right to left
        // is a phone number nobody can dial from the screen.
        : <span dir="ltr" className="tnum text-xs text-ink-muted">{r.phone}</span>),
    },
    {
      key: 'login',
      header: t.payroll.linkAccount,
      render: (r) => (r.has_login
        ? (
          <Badge tone="brand">
            {r.role_name
              ? (locale === 'en' ? (r.role_name_en ?? r.role_name) : r.role_name)
              : t.payroll.hasAccount}
          </Badge>
        )
        : <span className="text-xs text-ink-faint">{t.payroll.noAccount}</span>),
    },
    {
      key: 'paid',
      header: t.payroll.lastPaid,
      render: (r) => (r.last_paid_at
        ? (
          <span className="flex flex-col items-start gap-0.5">
            <span className="text-xs whitespace-nowrap text-ink-muted">
              {formatDate(r.last_paid_at, locale)}
            </span>
            <span className="text-xs text-ink-faint tnum">
              {r.paid_count} {t.payroll.timesPaid} · {formatMoney(Number(r.paid_total ?? 0), locale)}
            </span>
          </span>
        )
        : <span className="text-xs text-ink-faint">{t.payroll.neverPaid}</span>),
    },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <RecordActions
          archived={!r.is_active}
          onEdit={mayWrite ? () => setEditingId(r.id) : undefined}
          onDelete={mayWrite ? () => setDeletingId(r.id) : undefined}
        />
      ),
    },
  ];

  if (people.loading && rows.length === 0) return <PageSkeleton label={t.payroll.people} />;
  if (people.error) return <ErrorState message={t.common.error} detail={people.error} />;

  return (
    <>
      <PageHeader
        eyebrow={t.navGroups.money}
        title={t.payroll.title}
        subtitle={t.payroll.subtitle}
      />
      <PayrollTabs />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard label={t.payroll.employees} value={active.length} />
        <StatCard
          label={t.payroll.monthlyCost}
          value={formatMoney(monthly, locale)}
          hint={t.payroll.perMonth}
          emphasis
        />
        <StatCard
          label={t.payroll.totalPaid}
          value={formatMoney(rows.reduce((s, r) => s + Number(r.paid_total ?? 0), 0), locale)}
        />
      </div>

      <Card>
        <CardHeader
          title={t.payroll.people}
          hint={t.payroll.peopleHint}
          action={mayWrite
            ? <Button size="sm" onClick={() => setCreating(true)}>{t.payroll.addPerson}</Button>
            : undefined}
        />
        <DataTable
          rows={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={people.loading}
          error={people.error}
          emptyMessage={t.payroll.noPeople}
          loadingMessage={t.common.loading}
          errorMessage={t.common.error}
          emptyAction={mayWrite
            ? <Button onClick={() => setCreating(true)}>{t.payroll.addPerson}</Button>
            : undefined}
        />
      </Card>

      <div className="mt-4">
        <Notice tone="info">{t.payroll.linkHint}</Notice>
      </div>

      {creating && (
        <CreateRecordModal
          open
          onClose={() => setCreating(false)}
          table="employees"
          fields={fields}
          values={{ is_active: true, base_salary: 0 }}
          title={t.payroll.addPerson}
          onSaved={() => { people.reload(); }}
        />
      )}

      {editing && (
        <EditRecordModal
          open
          onClose={() => setEditingId(null)}
          table="employees"
          id={editing.id}
          fields={fields}
          values={editing as unknown as Record<string, unknown>}
          title={t.payroll.editPerson}
          onSaved={() => { people.reload(); }}
        />
      )}

      <DeleteRecordDialog
        kind="employee"
        id={deletingId}
        open={deletingId !== null}
        onClose={() => setDeletingId(null)}
        onDone={() => { people.reload(); }}
      />
    </>
  );
}
