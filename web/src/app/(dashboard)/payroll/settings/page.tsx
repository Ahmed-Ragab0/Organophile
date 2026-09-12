'use client';

import { useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useAccess } from '@/lib/access/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { createClient } from '@/lib/supabase/client';
import { formatMoney } from '@/lib/format';
import {
  DEFAULT_THANKS_TEMPLATE, MESSAGE_VARIABLES, messageVariables, renderTemplate,
} from '@/lib/payroll';
import {
  Badge, Button, Card, CardHeader, Field, Input, Notice, PageHeader, Select,
  Textarea, cx,
} from '@/components/ui/primitives';
import { DirectionBadge, PayrollTabs } from '@/components/payroll/parts';
import {
  CreateRecordModal, DeleteRecordDialog, EditRecordModal, RecordActions,
  type FieldSpec,
} from '@/components/record-actions';
import type {
  ExpenseCategory, PayrollSettingsRow, PayslipRow, SalaryComponentRow, WalletBalance,
} from '@/types/database';

/**
 * The parts of payroll that are set once and then left alone: what the
 * thank-you message says, what a payslip line can be called, and where a
 * salary lands in the books.
 */
export default function PayrollSettingsPage() {
  const { t } = useI18n();
  const { can } = useAccess();
  const mayWrite = can('payroll.write');

  const settings = useSupabaseQuery<PayrollSettingsRow>(
    (sb) => sb.from('payroll_settings').select('*').limit(1).single(), [],
  );
  const components = useSupabaseQuery<SalaryComponentRow[]>(
    (sb) => sb.from('v_salary_components').select('*').order('direction').order('sort_order'), [],
  );
  const wallets = useSupabaseQuery<WalletBalance[]>(
    (sb) => sb.from('v_wallet_balances').select('*').order('sort_order'), [],
  );
  const categories = useSupabaseQuery<ExpenseCategory[]>(
    (sb) => sb.from('expense_categories').select('*').order('sort_order').order('name'), [],
  );
  // The newest payslip, used only to fill the preview with real names and real
  // figures. A preview built from "٠٠٠" teaches nothing about how the message
  // will actually read.
  const sample = useSupabaseQuery<PayslipRow[]>(
    (sb) => sb.from('v_payslips').select('*').order('created_at', { ascending: false }).limit(1),
    [],
  );

  return (
    <>
      <PageHeader
        eyebrow={t.navGroups.money}
        title={t.payroll.title}
        subtitle={t.payroll.subtitle}
      />
      <PayrollTabs />

      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <MessageCard
          settings={settings.data ?? null}
          sample={(sample.data ?? [])[0] ?? null}
          mayWrite={mayWrite}
          onSaved={() => settings.reload()}
        />

        <div className="space-y-4">
          <ComponentsCard
            rows={components.data ?? []}
            loading={components.loading}
            mayWrite={mayWrite}
            onChanged={() => components.reload()}
          />

          <FilingCard
            settings={settings.data ?? null}
            wallets={(wallets.data ?? []).filter((w) => w.is_active)}
            categories={(categories.data ?? []).filter((c) => c.is_active)}
            mayWrite={mayWrite}
            onSaved={() => settings.reload()}
          />
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <Notice tone="info">{t.payroll.ledgerNote}</Notice>
        <Notice tone="info">{t.payroll.frozenNote}</Notice>
      </div>
    </>
  );
}

/* --------------------------------------------------------------- message */

/**
 * The thank-you message, and what it will actually look like.
 *
 * The variable chips insert at the cursor rather than appending, because a
 * message is written as a sentence and a name that always lands at the end is
 * a name you then have to cut and paste. The preview underneath is rendered
 * from a real payslip, so what you approve is what somebody receives.
 */
function MessageCard({
  settings, sample, mayWrite, onSaved,
}: {
  settings: PayrollSettingsRow | null;
  sample: PayslipRow | null;
  mayWrite: boolean;
  onSaved: () => void;
}) {
  const { t, locale } = useI18n();
  const box = useRef<HTMLTextAreaElement>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [template, setTemplate] = useState('');
  const [company, setCompany] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seeded from the row the moment it arrives, and again if it is reloaded
  // from elsewhere. Done during render rather than in an effect: both values
  // are known here, and an effect would paint an empty editor first.
  const stamp = settings?.updated_at ?? null;
  if (stamp !== null && loadedFor !== stamp) {
    setLoadedFor(stamp);
    setTemplate(settings?.thanks_template ?? DEFAULT_THANKS_TEMPLATE);
    setCompany(settings?.company_name ?? '');
  }

  function insert(variable: string) {
    const el = box.current;
    const token = `{${variable}}`;
    if (!el) { setTemplate((v) => v + token); return; }
    const start = el.selectionStart ?? template.length;
    const end = el.selectionEnd ?? start;
    const next = template.slice(0, start) + token + template.slice(end);
    setTemplate(next);
    // Put the caret after what was just inserted, on the next frame — the
    // textarea has not re-rendered with the new value yet.
    window.requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function save() {
    setBusy(true);
    setError(null);
    const { error: err } = await createClient()
      .from('payroll_settings')
      .update({ thanks_template: template, company_name: company.trim() })
      .eq('id', true);
    setBusy(false);
    if (err) { setError(err.message); return; }
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
    onSaved();
  }

  const preview = sample
    ? renderTemplate(template, messageVariables(sample, company, locale))
    : null;

  return (
    <Card>
      <CardHeader title={t.payroll.message} hint={t.payroll.messageHint} />

      <div className="space-y-4 px-5 py-5">
        <Field label={t.payroll.companyName}>
          <Input
            value={company}
            disabled={!mayWrite}
            onChange={(e) => setCompany(e.target.value)}
          />
        </Field>

        <div>
          <p className="mb-2 text-xs font-medium text-ink-muted">{t.payroll.messageHint}</p>
          <div className="mb-2.5 flex flex-wrap gap-1.5">
            {MESSAGE_VARIABLES.map((v) => (
              <button
                key={v}
                type="button"
                disabled={!mayWrite}
                onClick={() => insert(v)}
                className={cx(
                  'rounded-chip bg-accent-soft px-2 py-1 font-mono text-[0.6875rem] text-accent-strong',
                  'ring-1 ring-accent/20 transition-colors',
                  mayWrite ? 'hover:bg-accent/15' : 'cursor-not-allowed opacity-60',
                )}
              >
                {`{${v}}`}
              </button>
            ))}
          </div>
          <Textarea
            ref={box}
            value={template}
            disabled={!mayWrite}
            onChange={(e) => setTemplate(e.target.value)}
            className="min-h-44 leading-relaxed"
          />
        </div>

        {preview !== null ? (
          <div>
            <p className="mb-1.5 flex items-center justify-between text-xs font-medium text-ink-muted">
              <span>{t.payroll.preview}</span>
              <span className="text-ink-faint">
                {t.payroll.previewFor} {sample?.employee_name}
              </span>
            </p>
            {/* Shaped like the bubble it becomes, so the line breaks and the
                length are judged the way the reader will see them. */}
            <p className="rounded-card rounded-se-sm bg-ok-soft px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap text-ink ring-1 ring-ok/20 ring-inset">
              {preview}
            </p>
          </div>
        ) : (
          <Notice tone="info">{t.payroll.previewNobody}</Notice>
        )}

        {error && <Notice tone="danger">{error}</Notice>}

        {mayWrite && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {saved && <span className="me-auto text-xs text-ok">{t.common.saved}</span>}
            <Button
              variant="ghost"
              onClick={() => setTemplate(DEFAULT_THANKS_TEMPLATE)}
              disabled={busy}
            >
              {t.payroll.resetTemplate}
            </Button>
            <Button onClick={() => void save()} disabled={busy}>
              {busy ? t.common.saving : t.payroll.saveTemplate}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------ components */

function ComponentsCard({
  rows, loading, mayWrite, onChanged,
}: {
  rows: SalaryComponentRow[];
  loading: boolean;
  mayWrite: boolean;
  onChanged: () => void;
}) {
  const { t, locale } = useI18n();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const editing = rows.find((r) => r.id === editingId) ?? null;

  const fields: FieldSpec[] = [
    { name: 'name', label: t.payroll.componentName, type: 'text', required: true },
    { name: 'name_en', label: t.payroll.componentNameEn, type: 'text' },
    {
      name: 'direction',
      label: t.payroll.direction,
      type: 'select',
      required: true,
      options: [
        { value: 'earning', label: t.payroll.earning },
        { value: 'deduction', label: t.payroll.deduction },
      ],
      // A component in use cannot change sides: the lines already written
      // snapshotted their direction, so flipping it here would leave the
      // catalogue and the payslips telling two different stories.
      readOnly: editing !== null && editing.lines > 0,
    },
    { name: 'sort_order', label: t.payroll.sortOrder, type: 'number' },
    { name: 'is_active', label: t.payroll.activeLabel, type: 'checkbox' },
  ];

  return (
    <Card>
      <CardHeader
        title={t.payroll.components}
        hint={t.payroll.componentsHint}
        action={mayWrite
          ? (
            <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
              {t.payroll.addComponent}
            </Button>
          )
          : undefined}
      />
      <ul className="divide-y divide-border">
        {rows.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
                <span className="truncate">
                  {locale === 'en' ? (c.name_en ?? c.name) : c.name}
                </span>
                <DirectionBadge direction={c.direction} />
                {c.is_system && <Badge tone="neutral">{t.payroll.systemBadge}</Badge>}
              </p>
              <p className="mt-0.5 text-xs text-ink-faint tnum">
                {c.lines} {t.payroll.linesCount}
                {c.lines > 0 && ` · ${formatMoney(Number(c.total ?? 0), locale)}`}
              </p>
            </div>
            <RecordActions
              archived={!c.is_active}
              onEdit={mayWrite ? () => setEditingId(c.id) : undefined}
              onDelete={mayWrite ? () => setDeletingId(c.id) : undefined}
            />
          </li>
        ))}
        {rows.length === 0 && (
          <li className="px-5 py-10 text-center text-sm text-ink-faint">
            {loading ? t.common.loading : t.payroll.noComponents}
          </li>
        )}
      </ul>

      {creating && (
        <CreateRecordModal
          open
          onClose={() => setCreating(false)}
          table="salary_components"
          fields={fields}
          values={{ is_active: true, sort_order: 100, direction: 'earning' }}
          title={t.payroll.addComponent}
          onSaved={onChanged}
        />
      )}

      {editing && (
        <EditRecordModal
          open
          onClose={() => setEditingId(null)}
          table="salary_components"
          id={editing.id}
          fields={fields}
          values={editing as unknown as Record<string, unknown>}
          title={t.records.edit}
          onSaved={onChanged}
        />
      )}

      <DeleteRecordDialog
        kind="salary_component"
        id={deletingId}
        open={deletingId !== null}
        onClose={() => setDeletingId(null)}
        onDone={onChanged}
      />
    </Card>
  );
}

/* ----------------------------------------------------------------- filing */

/** Where a salary goes when it is paid: which wallet, and which expense line. */
function FilingCard({
  settings, wallets, categories, mayWrite, onSaved,
}: {
  settings: PayrollSettingsRow | null;
  wallets: WalletBalance[];
  categories: ExpenseCategory[];
  mayWrite: boolean;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function set(patch: Partial<PayrollSettingsRow>) {
    setBusy(true);
    setError(null);
    const { error: err } = await createClient()
      .from('payroll_settings').update(patch).eq('id', true);
    setBusy(false);
    if (err) { setError(err.message); return; }
    onSaved();
  }

  return (
    <Card>
      <CardHeader title={t.payroll.settings} hint={t.payroll.expenseCategoryHint} />
      <div className="space-y-3 px-5 py-5">
        <Field label={t.payroll.defaultWallet} hint={t.payroll.defaultWalletHint}>
          <Select
            value={settings?.default_wallet_id ?? ''}
            disabled={!mayWrite || busy}
            onChange={(e) => void set({ default_wallet_id: e.target.value || null })}
          >
            <option value="">—</option>
            {wallets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
        </Field>

        <Field label={t.payroll.expenseCategory} hint={t.payroll.expenseCategoryHint}>
          <Select
            value={settings?.expense_category_id ?? ''}
            disabled={!mayWrite || busy}
            onChange={(e) => void set({ expense_category_id: e.target.value || null })}
          >
            <option value="">—</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>

        <Field label={t.payroll.invoiceNote} hint={t.common.optional}>
          <Input
            defaultValue={settings?.invoice_note ?? ''}
            disabled={!mayWrite || busy}
            onBlur={(e) => {
              const next = e.target.value.trim() || null;
              if (next !== (settings?.invoice_note ?? null)) void set({ invoice_note: next });
            }}
          />
        </Field>

        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Card>
  );
}
