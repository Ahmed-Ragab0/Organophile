'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { createClient } from '@/lib/supabase/client';
import { formatDate, formatDateTime, toCairoDateKey } from '@/lib/format';
import {
  Badge, Button, Field, Input, Modal, Notice, Select, Textarea, cx,
} from '@/components/ui/primitives';
import {
  Duration, Elapsed, PriorityBadge, ProjectChip, SessionStatusBadge, SourceBadge,
  TASK_COLUMNS, useStatusLabel, useTaskReason,
} from './parts';
import type {
  ProductivityRow, ProjectRow, TaskResult, TaskRow, TaskSessionRow, TaskStatus,
} from '@/types/database';

/**
 * One task, opened.
 *
 * Everything a card cannot show: the detail, the time already on it, and the
 * two verbs that matter — move it, and put the clock on it. Which of those are
 * offered depends on the reader, and the answer comes from the same permission
 * the database will check, so a button that appears always works.
 */
export function TaskModal({
  task, projects, people, sessions, open, onClose, onChanged,
  mayManage, mayWork, isMine,
}: {
  task: TaskRow;
  projects: ProjectRow[];
  people: ProductivityRow[];
  sessions: TaskSessionRow[];
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
  mayManage: boolean;
  mayWork: boolean;
  /** Whether the clock this person would start belongs on this task. */
  isMine: boolean;
}) {
  const { t, locale } = useI18n();
  const statusLabel = useStatusLabel();
  const reasonText = useTaskReason();

  const [draft, setDraft] = useState({
    title: task.title,
    description: task.description ?? '',
    project_id: task.project_id ?? '',
    assignee_id: task.assignee_id ?? '',
    priority: task.priority,
    due_on: task.due_on ?? '',
    estimate_minutes: task.estimate_minutes === null ? '' : String(task.estimate_minutes),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logging, setLogging] = useState(false);

  const dirty = draft.title !== task.title
    || draft.description !== (task.description ?? '')
    || draft.project_id !== (task.project_id ?? '')
    || draft.assignee_id !== (task.assignee_id ?? '')
    || draft.priority !== task.priority
    || draft.due_on !== (task.due_on ?? '')
    || draft.estimate_minutes !== (task.estimate_minutes === null ? '' : String(task.estimate_minutes));

  async function save() {
    setBusy(true);
    setError(null);
    const { error: err } = await createClient().from('tasks').update({
      title: draft.title.trim(),
      description: draft.description.trim() === '' ? null : draft.description.trim(),
      project_id: draft.project_id === '' ? null : draft.project_id,
      assignee_id: draft.assignee_id === '' ? null : draft.assignee_id,
      priority: draft.priority,
      due_on: draft.due_on === '' ? null : draft.due_on,
      estimate_minutes: draft.estimate_minutes === '' ? null : Number(draft.estimate_minutes),
    }).eq('id', task.id);
    setBusy(false);
    if (err) { setError(err.message); return; }
    onChanged();
  }

  async function move(status: TaskStatus) {
    setBusy(true);
    setError(null);
    const { data, error: err } = await createClient()
      .rpc('move_task', { p_task_id: task.id, p_status: status, p_after_id: null });
    setBusy(false);
    if (err) { setError(err.message); return; }
    const result = data as TaskResult | null;
    if (!result?.ok) { setError(reasonText(result?.reason)); return; }
    onChanged();
  }

  async function toggleTimer() {
    setBusy(true);
    setError(null);
    const sb = createClient();
    const { data, error: err } = task.is_running
      ? await sb.rpc('stop_task_timer', { p_note: null })
      : await sb.rpc('start_task_timer', { p_task_id: task.id });
    setBusy(false);
    if (err) { setError(err.message); return; }
    const result = data as TaskResult | null;
    if (!result?.ok) { setError(reasonText(result?.reason)); return; }
    onChanged();
  }

  const canEdit = mayManage;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t.tasks.editTask}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t.common.close}</Button>
          {canEdit && dirty && (
            <Button onClick={() => void save()} disabled={busy}>
              {busy ? t.common.saving : t.common.save}
            </Button>
          )}
        </>
      )}
    >
      <div className="space-y-4">
        {/* --------------------------------------------------------- move */}
        <div className="flex flex-wrap items-center gap-1.5">
          {TASK_COLUMNS.map((s) => (
            <button
              key={s}
              type="button"
              disabled={busy || !mayWork || s === task.status}
              onClick={() => void move(s)}
              className={cx(
                'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                s === task.status
                  ? 'brand-ramp text-white shadow-card'
                  : 'border border-border bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink',
                (!mayWork || busy) && s !== task.status && 'cursor-not-allowed opacity-50',
              )}
            >
              {statusLabel(s)}
            </button>
          ))}
          {task.status === 'cancelled' && <Badge tone="neutral">{t.tasks.cancelled}</Badge>}
        </div>

        {/* -------------------------------------------------------- clock */}
        {mayWork && isMine && task.status !== 'done' && task.status !== 'cancelled' && (
          <div className="flex flex-wrap items-center gap-3 rounded-field border border-border bg-surface-2 px-3.5 py-3">
            {task.is_running && task.running_since ? (
              <>
                <span className="text-xs text-ink-muted">{t.tasks.running}</span>
                <span className="font-display text-lg font-semibold text-ok">
                  <Elapsed since={task.running_since} />
                </span>
                <Button size="sm" variant="danger" onClick={() => void toggleTimer()} disabled={busy}>
                  {t.tasks.stop}
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => void toggleTimer()} disabled={busy}>
                {t.tasks.start}
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => setLogging(true)} disabled={busy}>
              {t.tasks.logTime}
            </Button>
            <span className="ms-auto text-xs text-ink-faint">
              {t.tasks.spent}: <Duration minutes={task.minutes} />
            </span>
          </div>
        )}

        {/* ------------------------------------------------------- fields */}
        <Field label={t.tasks.taskTitle}>
          <Input
            value={draft.title}
            disabled={!canEdit}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          />
        </Field>

        <Field label={t.tasks.description}>
          <Textarea
            value={draft.description}
            disabled={!canEdit}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.tasks.project}>
            <Select
              value={draft.project_id}
              disabled={!canEdit}
              onChange={(e) => setDraft((d) => ({ ...d, project_id: e.target.value }))}
            >
              <option value="">—</option>
              {projects.filter((p) => p.is_active).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </Field>

          <Field label={t.tasks.assignee}>
            <Select
              value={draft.assignee_id}
              disabled={!canEdit}
              onChange={(e) => setDraft((d) => ({ ...d, assignee_id: e.target.value }))}
            >
              <option value="">{t.tasks.unassigned}</option>
              {people.filter((p) => p.is_active).map((p) => (
                <option key={p.id} value={p.id}>{p.full_name}</option>
              ))}
            </Select>
          </Field>

          <Field label={t.tasks.priority}>
            <Select
              value={draft.priority}
              disabled={!canEdit}
              onChange={(e) => setDraft((d) => ({
                ...d, priority: e.target.value as TaskRow['priority'],
              }))}
            >
              <option value="low">{t.tasks.priorityLow}</option>
              <option value="medium">{t.tasks.priorityMedium}</option>
              <option value="high">{t.tasks.priorityHigh}</option>
              <option value="urgent">{t.tasks.priorityUrgent}</option>
            </Select>
          </Field>

          <Field label={t.tasks.dueOn}>
            <Input
              type="date"
              value={draft.due_on}
              disabled={!canEdit}
              onChange={(e) => setDraft((d) => ({ ...d, due_on: e.target.value }))}
            />
          </Field>
        </div>

        {!canEdit && (
          <p className="text-xs text-ink-faint">
            {task.project_name && <ProjectChip name={task.project_name} colour={task.project_colour} />}
            {' '}
            <PriorityBadge priority={task.priority} />
          </p>
        )}

        {/* ------------------------------------------------------ history */}
        <div>
          <p className="mb-1.5 flex items-center justify-between text-xs font-medium text-ink-muted">
            <span>{t.tasks.timeEntries}</span>
            <span className="text-ink-faint"><Duration minutes={task.minutes} /></span>
          </p>
          {sessions.length === 0 ? (
            <p className="rounded-field border border-dashed border-border px-3.5 py-4 text-center text-xs text-ink-faint">
              {t.tasks.noEntries}
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-field border border-border">
              {sessions.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                  <span className="min-w-0">
                    <span className="block truncate text-xs text-ink">
                      {s.employee_name ?? '—'} · {formatDate(s.started_at, locale)}
                    </span>
                    {s.note && (
                      <span className="mt-0.5 block truncate text-xs text-ink-faint">{s.note}</span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <SourceBadge source={s.source} />
                    <SessionStatusBadge status={s.status} />
                    <span className={cx('text-xs', s.counts ? 'text-ink' : 'text-ink-faint line-through')}>
                      <Duration minutes={s.minutes} />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {task.completed_at && (
          <p className="text-xs text-ink-faint">
            {t.tasks.done} · {formatDateTime(task.completed_at, locale)}
          </p>
        )}

        {error && <Notice tone="danger">{error}</Notice>}
      </div>

      {logging && (
        <LogTimeModal
          task={task}
          open
          onClose={() => setLogging(false)}
          onLogged={onChanged}
        />
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------- manual time */

/**
 * Time the app did not watch.
 *
 * It goes in as a CLAIM and says so on the way in — the notice is not a
 * disclaimer, it is the difference between this and the timer, and somebody
 * typing three hours in should know before they press the button that a
 * person will read it.
 */
export function LogTimeModal({
  task, open, onClose, onLogged,
}: {
  task: TaskRow;
  open: boolean;
  onClose: () => void;
  onLogged: () => void;
}) {
  const { t } = useI18n();
  const reasonText = useTaskReason();
  const [day, setDay] = useState(() => toCairoDateKey(new Date()));
  const [from, setFrom] = useState('09:00');
  const [to, setTo] = useState('10:00');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    // Cairo, spelled out, so the browser's own timezone never decides which
    // day these hours land on.
    const { data, error: err } = await createClient().rpc('log_manual_time', {
      p_task_id: task.id,
      p_started_at: `${day}T${from}:00+02:00`,
      p_ended_at: `${day}T${to}:00+02:00`,
      p_note: note.trim() === '' ? null : note.trim(),
    });
    setBusy(false);
    if (err) { setError(err.message); return; }
    const result = data as TaskResult | null;
    if (!result?.ok) { setError(reasonText(result?.reason)); return; }
    onLogged();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t.tasks.logTimeTitle.replace('{task}', task.title)}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? t.common.saving : t.tasks.logTime}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <Notice tone="info">{t.tasks.manualHint}</Notice>
        <Field label={t.tasks.onDay}>
          <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.tasks.from}>
            <Input type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={t.tasks.to}>
            <Input type="time" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <Field label={t.tasks.note} hint={t.common.optional}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- new task */

export function NewTaskModal({
  projects, people, defaultStatus, defaultAssignee, open, onClose, onCreated, mayManage,
}: {
  projects: ProjectRow[];
  people: ProductivityRow[];
  defaultStatus: TaskStatus;
  /** Yourself, unless a manager picks somebody. */
  defaultAssignee: string | null;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  mayManage: boolean;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState('');
  const [assignee, setAssignee] = useState(defaultAssignee ?? '');
  const [priority, setPriority] = useState<TaskRow['priority']>('medium');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (title.trim() === '') return;
    setBusy(true);
    setError(null);
    const { error: err } = await createClient().from('tasks').insert({
      title: title.trim(),
      project_id: projectId === '' ? null : projectId,
      assignee_id: assignee === '' ? null : assignee,
      priority,
      due_on: due === '' ? null : due,
      status: defaultStatus,
    });
    setBusy(false);
    if (err) { setError(err.message); return; }
    onCreated();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t.tasks.newTask}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
          <Button onClick={() => void submit()} disabled={busy || title.trim() === ''}>
            {busy ? t.common.saving : t.common.add}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <Field label={t.tasks.taskTitle}>
          <Input
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.tasks.project}>
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">—</option>
              {projects.filter((p) => p.is_active).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </Field>
          <Field
            label={t.tasks.assignee}
            /* Handing work to somebody else is a management act, and the
               database refuses it — so the control is simply not offered. */
            hint={mayManage ? undefined : t.tasks.mine}
          >
            <Select
              value={assignee}
              disabled={!mayManage}
              onChange={(e) => setAssignee(e.target.value)}
            >
              <option value="">{t.tasks.unassigned}</option>
              {people.filter((p) => p.is_active).map((p) => (
                <option key={p.id} value={p.id}>{p.full_name}</option>
              ))}
            </Select>
          </Field>
          <Field label={t.tasks.priority}>
            <Select
              value={priority}
              onChange={(e) => setPriority(e.target.value as TaskRow['priority'])}
            >
              <option value="low">{t.tasks.priorityLow}</option>
              <option value="medium">{t.tasks.priorityMedium}</option>
              <option value="high">{t.tasks.priorityHigh}</option>
              <option value="urgent">{t.tasks.priorityUrgent}</option>
            </Select>
          </Field>
          <Field label={t.tasks.dueOn}>
            <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Modal>
  );
}
