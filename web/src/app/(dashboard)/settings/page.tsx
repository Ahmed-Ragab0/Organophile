'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useAccess } from '@/lib/access/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { formatMoney, formatNumber } from '@/lib/format';
import { Badge, Button, Card, CardHeader, Notice, PageHeader } from '@/components/ui/primitives';
import {
  CreateRecordModal, DeleteRecordDialog, EditRecordModal, RecordActions,
  type FieldSpec, type RecordKind,
} from '@/components/record-actions';
import type { ExpenseCategoryRow, PlanKindRow } from '@/types/database';

/**
 * The lists the rest of the app picks from.
 *
 * Every dropdown in this system used to get its contents from one of three
 * places: a table, a CHECK constraint, or a frozen array in the front end. The
 * first is editable and the other two are a deploy. This page is where the
 * second and third stopped being true — so it holds the lists themselves, not
 * settings in the sense of switches.
 *
 * Rows are deliberately dense: these are lists you scan and occasionally
 * correct, not dashboards. What earns its space next to each name is the one
 * number that decides whether it can be removed.
 */

/** One row of a list. Extracted so the two lists cannot drift apart. */
function ListRow({
  name, meta, badge, mayWrite, onEdit, onDelete, archived,
}: {
  name: string;
  meta: string;
  badge?: string;
  archived?: boolean;
  /** Read-only roles see the list; the verbs are simply not there. */
  mayWrite: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
      <div className="min-w-0">
        <p className="flex items-center gap-2 truncate font-medium text-ink">
          {name}
          {badge && <Badge tone="neutral">{badge}</Badge>}
        </p>
        <p className="mt-0.5 text-xs text-ink-faint tnum">{meta}</p>
      </div>
      <RecordActions
        archived={archived}
        onEdit={mayWrite ? onEdit : undefined}
        onDelete={mayWrite ? onDelete : undefined}
      />
    </li>
  );
}

function ListCard({
  title, hint, addLabel, empty, loading, count, mayWrite, onAdd, children,
}: {
  title: string;
  hint: string;
  addLabel: string;
  empty: string;
  loading: boolean;
  count: number;
  mayWrite: boolean;
  onAdd: () => void;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Card>
      <CardHeader
        title={title}
        hint={hint}
        action={mayWrite
          ? <Button size="sm" variant="secondary" onClick={onAdd}>{addLabel}</Button>
          : undefined}
      />
      <ul className="divide-y divide-border">
        {children}
        {count === 0 && (
          <li className="px-5 py-10 text-center text-sm text-ink-faint">
            {loading ? t.common.loading : empty}
          </li>
        )}
      </ul>
    </Card>
  );
}

export default function SettingsPage() {
  const { t, locale } = useI18n();
  const { can } = useAccess();
  const mayWrite = can('settings.write');
  const [creating, setCreating] = useState<RecordKind | null>(null);
  const [editing, setEditing] = useState<
    { kind: RecordKind; id: string; values: Record<string, unknown> } | null>(null);
  const [deleting, setDeleting] = useState<{ kind: RecordKind; id: string } | null>(null);

  const categories = useSupabaseQuery<ExpenseCategoryRow[]>(
    (sb) => sb.from('v_expense_categories').select('*').order('sort_order').order('name'), [],
  );
  const kinds = useSupabaseQuery<PlanKindRow[]>(
    (sb) => sb.from('v_plan_kinds').select('*').order('sort_order').order('name'), [],
  );

  function reloadAll() { categories.reload(); kinds.reload(); }

  const fieldsFor: Record<string, FieldSpec[]> = {
    expense_category: [
      { name: 'name', label: t.settings.categoryName, type: 'text', required: true },
      { name: 'sort_order', label: t.settings.sortOrder, type: 'number' },
      { name: 'is_active', label: t.settings.activeLabel, type: 'checkbox' },
    ],
    plan_kind: [
      { name: 'name', label: t.settings.planKindName, type: 'text', required: true },
      { name: 'name_en', label: t.settings.planKindNameEn, type: 'text' },
      { name: 'sort_order', label: t.settings.sortOrder, type: 'number' },
      { name: 'is_active', label: t.settings.activeLabel, type: 'checkbox' },
    ],
  };

  const categoryRows = categories.data ?? [];
  const kindRows = kinds.data ?? [];

  return (
    <>
      <PageHeader eyebrow={t.navGroups.ops} title={t.settings.title} subtitle={t.settings.subtitle} />

      <div className="mb-4">
        <Notice tone="ok">{t.settings.renameNote}</Notice>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ListCard
          title={t.settings.expenseCategories}
          hint={t.settings.expenseCategoriesHint}
          addLabel={t.settings.addCategory}
          empty={t.settings.emptyCategories}
          loading={categories.loading}
          count={categoryRows.length}
          mayWrite={mayWrite}
          onAdd={() => setCreating('expense_category')}
        >
          {categoryRows.map((c) => (
            <ListRow
              key={c.id}
              name={c.name}
              archived={!c.is_active}
              mayWrite={mayWrite}
              /* The count and the total together: one says whether it can be
                 removed, the other says whether it matters. */
              meta={`${formatNumber(c.entries, locale)} ${t.settings.entriesCount}`
                + (c.entries > 0 ? ` · ${formatMoney(Number(c.total ?? 0), locale)}` : '')}
              onEdit={() => setEditing({
                kind: 'expense_category', id: c.id,
                values: c as unknown as Record<string, unknown>,
              })}
              onDelete={() => setDeleting({ kind: 'expense_category', id: c.id })}
            />
          ))}
        </ListCard>

        <ListCard
          title={t.settings.planKinds}
          hint={t.settings.planKindsHint}
          addLabel={t.settings.addPlanKind}
          empty={t.settings.emptyPlanKinds}
          loading={kinds.loading}
          count={kindRows.length}
          mayWrite={mayWrite}
          onAdd={() => setCreating('plan_kind')}
        >
          {kindRows.map((k) => (
            <ListRow
              key={k.id}
              name={locale === 'en' ? (k.name_en ?? k.name) : k.name}
              badge={k.is_system ? t.settings.systemBadge : undefined}
              archived={!k.is_active}
              mayWrite={mayWrite}
              meta={`${formatNumber(k.packages, locale)} ${t.settings.packagesCount}`
                + ` · ${formatNumber(k.subscriptions, locale)} ${t.settings.subscriptionsCount}`}
              onEdit={() => setEditing({
                kind: 'plan_kind', id: k.id,
                values: k as unknown as Record<string, unknown>,
              })}
              onDelete={() => setDeleting({ kind: 'plan_kind', id: k.id })}
            />
          ))}
        </ListCard>
      </div>

      <div className="mt-4 space-y-2">
        <Notice tone="info">{t.settings.systemNote}</Notice>
        <Notice tone="info">{t.settings.kindLockNote}</Notice>
      </div>

      {creating && (
        <CreateRecordModal
          open
          onClose={() => setCreating(null)}
          table={creating === 'expense_category' ? 'expense_categories' : 'plan_kinds'}
          values={{ is_active: true, sort_order: 100 }}
          fields={fieldsFor[creating]}
          title={creating === 'expense_category'
            ? t.settings.addCategory
            : t.settings.addPlanKind}
          onSaved={reloadAll}
        />
      )}

      {editing && (
        <EditRecordModal
          open
          onClose={() => setEditing(null)}
          table={editing.kind === 'expense_category' ? 'expense_categories' : 'plan_kinds'}
          id={editing.id}
          fields={fieldsFor[editing.kind]}
          values={editing.values}
          title={t.records.edit}
          onSaved={reloadAll}
        />
      )}

      <DeleteRecordDialog
        kind={deleting?.kind ?? 'expense_category'}
        id={deleting?.id ?? null}
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onDone={reloadAll}
      />
    </>
  );
}
