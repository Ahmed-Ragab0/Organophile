'use client';

import { useCallback, useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { createClient } from '@/lib/supabase/client';
import { formatMoney, formatNumber } from '@/lib/format';
import {
  Badge, Button, Checkbox, Field, Input, Modal, Notice, Select, Textarea,
} from '@/components/ui/primitives';

/** The record families `describe_record` / `delete_record` understand. */
export type RecordKind =
  | 'student' | 'course' | 'package' | 'subscription'
  | 'university' | 'track' | 'wallet' | 'installment_plan';

type LinkRow = { what: string; count: number; money: boolean };

type RecordInfo = {
  kind: RecordKind;
  exists: boolean;
  label: string | null;
  links: LinkRow[];
  money_count: number;
  money_amount: number;
  blocked_by_money: boolean;
  can_delete: boolean;
  can_archive: boolean;
  archived: boolean;
};

/** One editable field. The modal builds itself from a list of these. */
export type FieldSpec = {
  name: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'checkbox' | 'textarea' | 'lookup';
  options?: Array<{ value: string; label: string }>;
  /**
   * `lookup` only: the table a missing option is created in, on the spot. A
   * student whose university is not in the list is the normal case, not an
   * error, and sending someone to another screen to fix it loses the form.
   */
  lookupTable?: string;
  lookupPrompt?: string;
  hint?: string;
  required?: boolean;
  /** Shown for context, never sent. */
  readOnly?: boolean;
};

/* ------------------------------------------------------------------ delete */

/**
 * Deleting is asked as a question the database has already answered.
 *
 * The dialog calls `describe_record` before it offers anything, so it opens
 * with what is attached rather than a bare "are you sure?" — and when money is
 * attached it does not offer the delete at all. That refusal comes from the
 * database, not from this file; a screen can only ever suggest.
 *
 * A blocked delete always leaves somewhere to go: archiving keeps the history
 * and takes the record out of the working lists.
 */
export function DeleteRecordDialog({
  kind, id, open, onClose, onDone,
}: {
  kind: RecordKind;
  id: string | null;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, locale } = useI18n();
  const [info, setInfo] = useState<RecordInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const load = useCallback(async (recordId: string) => {
    setError(null);
    const { data, error: err } = await createClient()
      .rpc('describe_record', { p_kind: kind, p_id: recordId });
    if (err) { setError(err.message); return; }
    setInfo(data as RecordInfo);
  }, [kind]);

  // Reload when the dialog opens on a different record. Done during render
  // rather than in an effect: both values are already known here, and an
  // effect would re-fetch on every unrelated re-render.
  if (open && id && loadedFor !== id) {
    setLoadedFor(id);
    setInfo(null);
    void load(id);
  }
  if (!open && loadedFor !== null) setLoadedFor(null);

  if (!open || !id) return null;

  async function run(action: 'delete' | 'archive') {
    if (!id) return;
    setBusy(true);
    setError(null);
    const sb = createClient();
    const { data, error: err } = action === 'delete'
      ? await sb.rpc('delete_record', { p_kind: kind, p_id: id })
      : await sb.rpc('archive_record', { p_kind: kind, p_id: id, p_archived: true });
    setBusy(false);

    if (err) { setError(err.message); return; }
    const result = data as { ok?: boolean; reason?: string } | null;
    if (!result?.ok) {
      // The database refused. Show its reason rather than a generic failure,
      // and refresh the counts in case they moved since the dialog opened.
      const reason = (result?.reason ?? 'unknown') as keyof typeof t.records.reasons;
      setError(t.records.reasons[reason] ?? result?.reason ?? t.common.error);
      void load(id);
      return;
    }
    onDone();
    onClose();
  }

  return (
    <Modal open onClose={onClose} title={t.records.deleteTitle}>
      <div className="space-y-4">
        {!info && !error && <p className="text-sm text-ink-muted">{t.common.loading}</p>}

        {info && (
          <>
            <p className="text-sm text-ink">
              {t.records.kinds[kind]}: <strong>{info.label ?? ''}</strong>
            </p>

            {info.links.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-medium text-ink-muted">{t.records.attached}</p>
                <ul className="divide-y divide-border rounded-field border border-border">
                  {info.links.map((l) => (
                    <li key={l.what} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="text-sm text-ink">
                        {t.records.linkKinds[l.what as keyof typeof t.records.linkKinds] ?? l.what}
                      </span>
                      <span className="flex items-center gap-2">
                        {l.money && <Badge tone="warn">{t.records.isMoney}</Badge>}
                        <span className="tnum text-sm text-ink-muted">
                          {formatNumber(l.count, locale)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {info.blocked_by_money ? (
              <Notice tone="danger">
                {t.records.blockedByMoney.replace(
                  '{amount}', formatMoney(Number(info.money_amount ?? 0), locale),
                )}
              </Notice>
            ) : info.links.length > 0 ? (
              <Notice tone="warn">
                {kind === 'university' || kind === 'track'
                  ? t.records.detachClassification
                  : t.records.detachWarning}
              </Notice>
            ) : (
              <Notice tone="info">{t.records.nothingAttached}</Notice>
            )}
          </>
        )}

        {error && <Notice tone="danger">{error}</Notice>}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
          {info?.can_archive && !info.archived && (
            <Button variant="secondary" onClick={() => run('archive')} disabled={busy}>
              {t.records.archive}
            </Button>
          )}
          <Button
            variant="danger"
            onClick={() => run('delete')}
            disabled={busy || !info?.can_delete}
          >
            {busy ? t.common.saving : t.records.confirmDelete}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------- create and edit */

/**
 * One form for every entity, built from a field list rather than written per
 * screen. Creating and editing differ by a single line — an insert or an
 * update — so they are the same component: two forms would drift.
 *
 * Editing sends only changed fields, so an untouched form writes nothing and
 * `updated_at` stays honest about when a record last actually changed.
 */
function RecordFormModal<T extends Record<string, unknown>>({
  open, onClose, table, id, fields, values, title, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  table: string;
  /** null creates a new row; a string updates that one. */
  id: string | null;
  fields: FieldSpec[];
  values: T;
  title: string;
  onSaved: (id?: string) => void;
}) {
  const { t } = useI18n();

  function blank(f: FieldSpec) { return f.type === 'checkbox' ? false : ''; }
  function seed() {
    return Object.fromEntries(fields.map((f) => [f.name, values[f.name] ?? blank(f)]));
  }

  const [draft, setDraft] = useState<Record<string, unknown>>(seed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  // Options created from inside this form, kept locally so the new one is
  // selected immediately instead of after a round trip through the parent.
  const [added, setAdded] = useState<Record<string, Array<{ value: string; label: string }>>>({});
  const [adding, setAdding] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  const key = id ?? '__new__';
  if (open && openedFor !== key) {
    setOpenedFor(key);
    setDraft(seed());
    setAdded({});
    setAdding(null);
    setNewName('');
    setError(null);
  }
  if (!open && openedFor !== null) setOpenedFor(null);

  if (!open) return null;

  async function createOption(f: FieldSpec) {
    const name = newName.trim();
    if (!f.lookupTable || name === '') return;
    setBusy(true);
    setError(null);
    const { data, error: err } = await createClient()
      .from(f.lookupTable).insert({ name }).select('id, name').single();
    setBusy(false);
    if (err) { setError(err.message); return; }
    const row = data as { id: string; name: string };
    setAdded((a) => ({
      ...a, [f.name]: [...(a[f.name] ?? []), { value: row.id, label: row.name }],
    }));
    setDraft((d) => ({ ...d, [f.name]: row.id }));
    setAdding(null);
    setNewName('');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const sb = createClient();

    if (id === null) {
      const row: Record<string, unknown> = {};
      for (const f of fields) {
        if (f.readOnly) continue;
        const v = draft[f.name];
        if (v === '' || v === undefined) continue;
        row[f.name] = f.type === 'number' ? Number(v) : v;
      }
      const { data, error: err } = await sb.from(table).insert(row).select('id').single();
      setBusy(false);
      if (err) { setError(err.message); return; }
      onSaved((data as { id: string } | null)?.id);
      onClose();
      return;
    }

    const patch: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.readOnly) continue;
      const next = draft[f.name];
      const before = values[f.name] ?? blank(f);
      if (String(next ?? '') === String(before ?? '')) continue;
      // An emptied box means "no value", not the empty string.
      patch[f.name] = next === '' ? null : f.type === 'number' ? Number(next) : next;
    }

    if (Object.keys(patch).length === 0) { setBusy(false); onClose(); return; }

    const { error: err } = await sb.from(table).update(patch).eq('id', id);
    setBusy(false);
    if (err) { setError(err.message); return; }
    onSaved(id);
    onClose();
  }

  return (
    <Modal open onClose={onClose} title={title}>
      <form onSubmit={submit} className="space-y-3">
        {fields.map((f) => {
          const value = draft[f.name];
          if (f.type === 'checkbox') {
            return (
              <Checkbox
                key={f.name}
                label={f.label}
                checked={Boolean(value)}
                onChange={(next) => setDraft((d) => ({ ...d, [f.name]: next }))}
              />
            );
          }

          if (f.type === 'lookup' || f.type === 'select') {
            const options = [...(f.options ?? []), ...(added[f.name] ?? [])];
            return (
              <Field key={f.name} label={f.required ? `${f.label} *` : f.label} hint={f.hint}>
                <div className="flex gap-2">
                  <Select
                    value={String(value ?? '')}
                    disabled={f.readOnly}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.name]: e.target.value }))}
                  >
                    <option value="">—</option>
                    {options.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </Select>
                  {f.type === 'lookup' && !f.readOnly && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => { setAdding(adding === f.name ? null : f.name); setNewName(''); }}
                    >
                      {adding === f.name ? t.common.cancel : t.records.addNew}
                    </Button>
                  )}
                </div>
                {adding === f.name && (
                  <div className="mt-2 flex gap-2">
                    <Input
                      value={newName}
                      placeholder={f.lookupPrompt ?? f.label}
                      onChange={(e) => setNewName(e.target.value)}
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy || newName.trim() === ''}
                      onClick={() => void createOption(f)}
                    >
                      {t.common.add}
                    </Button>
                  </div>
                )}
              </Field>
            );
          }

          return (
            <Field key={f.name} label={f.required ? `${f.label} *` : f.label} hint={f.hint}>
              {f.type === 'textarea' ? (
                <Textarea
                  value={String(value ?? '')}
                  readOnly={f.readOnly}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.name]: e.target.value }))}
                />
              ) : (
                <Input
                  type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                  step={f.type === 'number' ? '0.01' : undefined}
                  dir={f.type === 'number' ? 'ltr' : undefined}
                  value={String(value ?? '')}
                  required={f.required}
                  readOnly={f.readOnly}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.name]: e.target.value }))}
                />
              )}
            </Field>
          );
        })}

        {error && <Notice tone="danger">{error}</Notice>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
          <Button type="submit" disabled={busy}>{busy ? t.common.saving : t.common.save}</Button>
        </div>
      </form>
    </Modal>
  );
}

export function EditRecordModal<T extends Record<string, unknown>>(props: {
  open: boolean;
  onClose: () => void;
  table: string;
  id: string;
  fields: FieldSpec[];
  values: T;
  title: string;
  onSaved: () => void;
}) {
  return <RecordFormModal {...props} onSaved={() => props.onSaved()} />;
}

export function CreateRecordModal(props: {
  open: boolean;
  onClose: () => void;
  table: string;
  fields: FieldSpec[];
  title: string;
  /** Starting values — a create form opened from a filtered list can prefill. */
  values?: Record<string, unknown>;
  onSaved: (id?: string) => void;
}) {
  const { values = {}, ...rest } = props;
  return <RecordFormModal {...rest} id={null} values={values} />;
}

/* ----------------------------------------------------------------- actions */

/**
 * The same three verbs, in the same order, on every row in the app: look,
 * change, remove. Consistency here is not tidiness — it is what lets someone
 * stop reading the buttons.
 */
export function RecordActions({
  onView, onEdit, onDelete, archived,
}: {
  onView?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  archived?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-end gap-1.5">
      {archived && <Badge tone="neutral">{t.records.archived}</Badge>}
      {onView && <Button size="sm" variant="secondary" onClick={onView}>{t.records.view}</Button>}
      {onEdit && <Button size="sm" variant="ghost" onClick={onEdit}>{t.records.edit}</Button>}
      {onDelete && <Button size="sm" variant="ghost" onClick={onDelete}>{t.records.delete}</Button>}
    </div>
  );
}
