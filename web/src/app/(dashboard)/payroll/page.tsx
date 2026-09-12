'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n/context';
import { useAccess } from '@/lib/access/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { createClient } from '@/lib/supabase/client';
import { formatDate, formatMoney, toCairoDateKey } from '@/lib/format';
import { monthLabel } from '@/lib/payroll';
import {
  Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, Notice,
  PageHeader, PageSkeleton, cx,
} from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/table';
import { Money, StatCard } from '@/components/domain';
import {
  FlowTrack, PayrollTabs, StatusPill, usePayrollReason,
} from '@/components/payroll/parts';
import {
  InvoiceLink, PayDialog, PayslipModal, ReverseDialog, ThanksModal,
} from '@/components/payroll/dialogs';
import type {
  EmployeeRow, PayrollPeriodRow, PayrollResult, PayrollSettingsRow, PayslipRow,
  SalaryComponentRow, WalletBalance,
} from '@/types/database';

/**
 * Payroll, month by month.
 *
 * The page is built around the one thing that makes payroll different from
 * every other money screen in this system: it has a SEQUENCE. A salary is
 * drafted, checked, approved, and only then paid, and each of those is a
 * different person's job in a business with more than one person in it. So the
 * cycle is the object on screen and the payslips live inside it, rather than a
 * flat list of payments with a month column.
 *
 * Everything the screen shows about money comes back from the database after
 * the write — no total is computed here. A payroll screen that does its own
 * arithmetic is a payroll screen that can disagree with the ledger.
 */
export default function PayrollPage() {
  const { t, locale } = useI18n();
  const { can } = useAccess();
  const mayWrite = can('payroll.write');
  const reasonText = usePayrollReason();

  const [selected, setSelected] = useState<string | null>(null);
  const [month, setMonth] = useState(() => toCairoDateKey(new Date()).slice(0, 7));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  /*
   * The open dialog is stored as an ID and the row is looked up from the live
   * list on every render.
   *
   * Holding the row itself would mean the modal keeps showing the totals it
   * opened with: adding a deduction reloads the list, and a stored copy would
   * quietly go stale while the numbers behind it moved.
   */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [reversingId, setReversingId] = useState<string | null>(null);
  const [thankingId, setThankingId] = useState<string | null>(null);

  const periods = useSupabaseQuery<PayrollPeriodRow[]>(
    (sb) => sb.from('v_payroll_periods').select('*').order('period_month', { ascending: false }),
    [],
  );

  // The newest cycle unless one has been picked. Resolved here rather than in
  // an effect: both values are known during render, and an effect would flash
  // an empty panel first.
  const rows = periods.data ?? [];
  const current = rows.find((p) => p.id === selected) ?? rows[0] ?? null;

  const slips = useSupabaseQuery<PayslipRow[]>(
    (sb) => sb.from('v_payslips').select('*')
      .eq('period_id', current?.id ?? '00000000-0000-0000-0000-000000000000')
      .order('employee_name'),
    [current?.id ?? ''],
  );

  const wallets = useSupabaseQuery<WalletBalance[]>(
    (sb) => sb.from('v_wallet_balances').select('*').order('sort_order'), [],
  );
  const components = useSupabaseQuery<SalaryComponentRow[]>(
    (sb) => sb.from('v_salary_components').select('*').order('sort_order').order('name'), [],
  );
  const people = useSupabaseQuery<EmployeeRow[]>(
    (sb) => sb.from('v_employees').select('*').order('full_name'), [],
  );
  const settings = useSupabaseQuery<PayrollSettingsRow>(
    (sb) => sb.from('payroll_settings').select('*').limit(1).single(), [],
  );

  function reloadAll() {
    periods.reload();
    slips.reload();
    wallets.reload();
    people.reload();
  }

  async function openCycle(target: string) {
    setBusy(true);
    setError(null);
    setFlash(null);
    const { data, error: err } = await createClient().rpc('open_payroll_period', {
      p_month: `${target}-01`,
    });
    setBusy(false);
    if (err) { setError(err.message); return; }
    const result = data as PayrollResult | null;
    if (!result?.ok) { setError(reasonText(result?.reason)); return; }

    const label = monthLabel(result.period_month ?? `${target}-01`, locale);
    const added = result.added ?? 0;
    // Two different facts, said differently: a cycle that was created and
    // filled, and one that already existed and gained nobody.
    setFlash(added > 0
      ? t.payroll.cycleOpened.replace('{month}', label).replace('{count}', String(added))
      : t.payroll.cycleFound.replace('{month}', label));
    setSelected(result.id ?? null);
    reloadAll();
  }

  async function setStatus(status: string) {
    if (!current) return;
    setBusy(true);
    setError(null);
    const { error: err } = await createClient()
      .from('payroll_periods').update({ status }).eq('id', current.id);
    setBusy(false);
    if (err) { setError(err.message); return; }
    reloadAll();
  }

  async function refill() {
    if (!current) return;
    setBusy(true);
    setError(null);
    const { data, error: err } = await createClient()
      .rpc('generate_payslips', { p_period_id: current.id });
    setBusy(false);
    if (err) { setError(err.message); return; }
    const added = Number(data ?? 0);
    setFlash(added > 0
      ? t.payroll.refilled.replace('{count}', String(added))
      : t.payroll.refillNone);
    reloadAll();
  }

  async function removeSlip(slip: PayslipRow) {
    if (!window.confirm(t.payroll.confirmRemoveSlip.replace('{name}', slip.employee_name))) return;
    setError(null);
    const { error: err } = await createClient().from('payslips').delete().eq('id', slip.id);
    if (err) { setError(err.message); return; }
    reloadAll();
  }

  async function deleteCycle(period: PayrollPeriodRow) {
    const label = monthLabel(period.period_month, locale);
    if (!window.confirm(t.payroll.confirmDeleteCycle.replace('{month}', label))) return;
    setError(null);
    const { error: err } = await createClient()
      .from('payroll_periods').delete().eq('id', period.id);
    if (err) { setError(err.message); return; }
    setSelected(null);
    reloadAll();
  }

  const slipRows = slips.data ?? [];
  const byId = (id: string | null) => slipRows.find((s) => s.id === id) ?? null;
  const editing = byId(editingId);
  const paying = byId(payingId);
  const reversing = byId(reversingId);
  const thanking = byId(thankingId);

  const peopleRows = people.data ?? [];
  const activePeople = peopleRows.filter((p) => p.is_active);
  const monthlyCost = activePeople.reduce((s, p) => s + Number(p.base_salary ?? 0), 0);
  const paidEver = peopleRows.reduce((s, p) => s + Number(p.paid_total ?? 0), 0);

  const walletsFor = (slip: PayslipRow) =>
    peopleRows.find((p) => p.id === slip.employee_id)?.wallet_id
      ?? settings.data?.default_wallet_id
      ?? null;

  const columns: Array<Column<PayslipRow>> = [
    {
      key: 'employee',
      header: t.payroll.employee,
      render: (r) => (
        <span className="min-w-0">
          <span className="block truncate font-medium text-ink">{r.employee_name}</span>
          {r.job_title && (
            <span className="mt-0.5 block truncate text-xs text-ink-faint">{r.job_title}</span>
          )}
        </span>
      ),
    },
    {
      key: 'base',
      header: t.payroll.baseSalary,
      numeric: true,
      render: (r) => <Money value={r.base_salary} tone="plain" />,
    },
    {
      key: 'additions',
      header: t.payroll.additions,
      numeric: true,
      render: (r) => (r.earnings_total > 0
        ? <Money value={r.earnings_total} tone="ok" />
        : <span className="text-ink-faint">—</span>),
    },
    {
      key: 'deductions',
      header: t.payroll.deductionsShort,
      numeric: true,
      render: (r) => (r.deductions_total > 0
        ? <Money value={r.deductions_total} tone="danger" />
        : <span className="text-ink-faint">—</span>),
    },
    {
      key: 'net',
      header: t.payroll.net,
      numeric: true,
      render: (r) => (
        <strong className="font-display font-semibold"><Money value={r.net_amount} tone="plain" /></strong>
      ),
    },
    {
      key: 'state',
      header: '',
      render: (r) => (r.paid_at
        ? (
          <span className="flex flex-col items-start gap-0.5">
            <span className="text-xs font-medium text-ok">{t.payroll.paid}</span>
            <span className="text-xs whitespace-nowrap text-ink-faint">
              {formatDate(r.paid_at, locale)}
              {r.paid_wallet_name && ` · ${r.paid_wallet_name}`}
            </span>
          </span>
        )
        : <span className="text-xs text-ink-faint">{t.payroll.unpaid}</span>),
    },
    {
      key: 'actions',
      header: '',
      numeric: true,
      render: (r) => (
        <span className="flex flex-wrap items-center justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setEditingId(r.id)}>
            {r.paid_at ? t.records.view : t.common.edit}
          </Button>
          {r.paid_at === null && mayWrite && current?.status === 'approved' && (
            <Button size="sm" onClick={() => setPayingId(r.id)}>{t.payroll.pay}</Button>
          )}
          {r.paid_at !== null && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setThankingId(r.id)}>
                {t.payroll.message}
              </Button>
              <InvoiceLink id={r.id} label={t.payroll.invoice} />
              {mayWrite && (
                <Button size="sm" variant="ghost" onClick={() => setReversingId(r.id)}>
                  {t.payroll.reverse}
                </Button>
              )}
            </>
          )}
          {r.paid_at === null && mayWrite && current?.status !== 'approved' && (
            <Button size="sm" variant="ghost" onClick={() => void removeSlip(r)}>
              {t.payroll.removeFromCycle}
            </Button>
          )}
        </span>
      ),
    },
  ];

  if (periods.loading && rows.length === 0) return <PageSkeleton label={t.payroll.title} />;
  if (periods.error) return <ErrorState message={t.common.error} detail={periods.error} />;

  return (
    <>
      <PageHeader
        eyebrow={t.navGroups.money}
        title={t.payroll.title}
        subtitle={t.payroll.subtitle}
      />
      <PayrollTabs />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={t.payroll.employees} value={activePeople.length} />
        <StatCard
          label={t.payroll.paidThisCycle}
          value={current ? `${current.paid_count} ${t.payroll.ofCount} ${current.slips}` : '—'}
          tone={current && current.slips > 0 && current.paid_count === current.slips ? 'ok' : 'neutral'}
        />
        <StatCard
          label={t.payroll.monthlyCost}
          value={formatMoney(monthlyCost, locale)}
          hint={t.payroll.perMonth}
        />
        <StatCard label={t.payroll.totalPaid} value={formatMoney(paidEver, locale)} emphasis />
      </div>

      {flash && <div className="mb-3"><Notice tone="ok">{flash}</Notice></div>}
      {error && <div className="mb-3"><Notice tone="danger">{error}</Notice></div>}

      <div className="grid gap-4 lg:grid-cols-[320px_1fr] lg:items-start">
        <Card>
          <CardHeader
            title={t.payroll.cycles}
            hint={t.payroll.cyclesHint}
            action={mayWrite
              ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void openCycle(toCairoDateKey(new Date()).slice(0, 7))}
                >
                  {t.payroll.openCycle}
                </Button>
              )
              : undefined}
          />

          {mayWrite && (
            <div className="flex items-end gap-2 border-b border-border px-4 py-3">
              <div className="flex-1">
                <Field label={t.payroll.chooseMonth}>
                  <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
                </Field>
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || month === ''}
                onClick={() => void openCycle(month)}
              >
                {t.payroll.openMonth}
              </Button>
            </div>
          )}

          {rows.length === 0 ? (
            <EmptyState message={t.payroll.noCycles} />
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((p) => {
                const active = current?.id === p.id;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(p.id)}
                      className={cx(
                        'flex w-full flex-col gap-2 px-4 py-3 text-start transition-colors',
                        active ? 'bg-brand-soft' : 'hover:bg-surface-2',
                      )}
                    >
                      <span className="flex w-full items-center justify-between gap-2">
                        <span className={cx('font-medium', active ? 'text-brand-strong' : 'text-ink')}>
                          {monthLabel(p.period_month, locale)}
                        </span>
                        <StatusPill status={p.status} />
                      </span>
                      <span className="flex w-full items-center justify-between gap-2 text-xs text-ink-faint">
                        <span className="tnum">
                          {p.paid_count} {t.payroll.ofCount} {p.slips} {t.payroll.slipsCount}
                        </span>
                        <Money value={p.net_total} tone="plain" className="text-xs" />
                      </span>
                      <FlowTrack status={p.status} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="space-y-4">
          {current === null ? (
            <Card>
              <EmptyState message={t.payroll.noCycles} />
            </Card>
          ) : (
            <Card>
              <CardHeader
                title={monthLabel(current.period_month, locale)}
                hint={current.approved_at
                  ? `${t.payroll.approvedAt} ${formatDate(current.approved_at, locale)}`
                  : t.payroll.cyclesHint}
                action={(
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusPill status={current.status} />
                    {mayWrite && current.status === 'draft' && (
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void setStatus('review')}>
                        {t.payroll.toReview}
                      </Button>
                    )}
                    {mayWrite && current.status === 'review' && (
                      <Button size="sm" disabled={busy} onClick={() => void setStatus('approved')}>
                        {t.payroll.toApprove}
                      </Button>
                    )}
                    {mayWrite && current.status === 'approved' && current.paid_count === 0 && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void setStatus('review')}>
                        {t.payroll.reopen}
                      </Button>
                    )}
                    {mayWrite && (current.status === 'draft' || current.status === 'review') && (
                      <>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refill()}>
                          {t.payroll.refill}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void deleteCycle(current)}>
                          {t.payroll.deleteCycle}
                        </Button>
                      </>
                    )}
                  </span>
                )}
              />

              {current.status !== 'approved' && current.status !== 'closed' && (
                <div className="px-4 pt-3">
                  <Notice tone="info">{t.payroll.approveFirstNote}</Notice>
                </div>
              )}

              <DataTable
                rows={slipRows}
                columns={columns}
                keyOf={(r) => r.id}
                loading={slips.loading}
                error={slips.error}
                emptyMessage={t.payroll.noPeople}
                loadingMessage={t.common.loading}
                errorMessage={t.common.error}
              />

              {slipRows.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 text-sm">
                  <span className="text-ink-muted">{t.common.total}</span>
                  <span className="flex items-center gap-4">
                    <span className="text-xs text-ink-faint">
                      {t.payroll.paid}: <Money value={current.paid_total} tone="plain" className="text-xs" />
                    </span>
                    <strong className="font-display text-base">
                      <Money value={current.net_total} tone="plain" />
                    </strong>
                  </span>
                </div>
              )}
            </Card>
          )}

          <Notice tone="info">{t.payroll.ledgerNote}</Notice>
          <p className="text-xs text-ink-faint">
            <Link href="/expenses" className="underline underline-offset-2 hover:text-ink">
              {t.nav.expenses}
            </Link>
          </p>
        </div>
      </div>

      {editing && (
        <PayslipModal
          key={editing.id}
          open
          slip={editing}
          components={components.data ?? []}
          mayWrite={mayWrite}
          onClose={() => setEditingId(null)}
          onSaved={reloadAll}
        />
      )}

      {paying && (
        <PayDialog
          key={paying.id}
          open
          slip={paying}
          wallets={(wallets.data ?? []).filter((w) => w.is_active)}
          defaultWalletId={walletsFor(paying)}
          onClose={() => setPayingId(null)}
          onPaid={reloadAll}
        />
      )}

      {reversing && (
        <ReverseDialog
          key={reversing.id}
          open
          slip={reversing}
          onClose={() => setReversingId(null)}
          onDone={reloadAll}
        />
      )}

      {thanking && (
        <ThanksModal
          key={thanking.id}
          open
          slip={thanking}
          template={settings.data?.thanks_template ?? ''}
          company={settings.data?.company_name ?? ''}
          onClose={() => setThankingId(null)}
          onSent={reloadAll}
        />
      )}
    </>
  );
}
