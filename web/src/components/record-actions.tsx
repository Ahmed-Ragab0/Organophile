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
  | 'university' | 'wallet' | 'installment_plan';

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
  type: 'text' | 'number' | 'date' | 'select' | 'checkbox' | 'textarea';
  options?: Array<{ value: string; label: string }>;
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
              <Notice tone="warn">{t.records.detachWarning}</Notice>
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

/* -------------------------------------------------------------------- edit */

/**
 * Editing, built from a field list rather than hand-written per screen.
 *
 * Every entity's form is the same form; the difference is a spec. Only changed
 * fields are sent, so an untouched form writes nothing and `updated_at` stays
 * honest about when a record last actually changed.
 */
export function EditRecordModal<T extends Record<string, unknown>>({
  open, onClose, table, id, fields, values, title, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  table: string;
  id: string;
  fields: FieldSpec[];
  values: T;
  title: string;
  onSaved: () => void;
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

  if (open && openedFor !== id) {
    setOpenedFor(id);
    setDraft(seed());
    setError(null);
  }
  if (!open && openedFor !== null) setOpenedFor(null);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

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

    const { error: err } = await createClient().from(table).update(patch).eq('id', id);
    setBusy(false);
    if (err) { setError(err.message); return; }
    onSaved();
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
          return (
            <Field key={f.name} label={f.required ? `${f.label} *` : f.label} hint={f.hint}>
              {f.type === 'select' ? (
                <Select
                  value={String(value ?? '')}
                  disabled={f.readOnly}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.name]: e.target.value }))}
                >
                  <option value="">—</option>
                  {(f.options ?? []).map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </Select>
              ) : f.type === 'textarea' ? (
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
