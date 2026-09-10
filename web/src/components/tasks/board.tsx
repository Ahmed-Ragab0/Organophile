'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { formatShortDay } from '@/lib/format';
import { Button, cx } from '@/components/ui/primitives';
import {
  Duration, Elapsed, PriorityBadge, ProjectChip, ProjectStripe,
  TASK_COLUMNS, useStatusLabel,
} from './parts';
import type { TaskRow, TaskStatus } from '@/types/database';

/**
 * The board.
 *
 * Three columns, not four: `cancelled` is a real status but it is not a place
 * work sits, so it lives behind the task itself rather than as a fourth pile
 * nobody looks at.
 *
 * Dragging is a convenience, not the interface. Every move is also available
 * from inside the task, because HTML5 drag-and-drop does not fire on touch and
 * cannot be driven from a keyboard — a board that can only be used with a
 * mouse is a board half the people cannot use.
 */

function DueDate({ task }: { task: TaskRow }) {
  const { t, locale } = useI18n();
  if (!task.due_on) return null;

  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 text-xs whitespace-nowrap',
        task.is_overdue ? 'font-medium text-danger' : 'text-ink-faint',
      )}
    >
      <svg aria-hidden viewBox="0 0 24 24" className="h-3 w-3" fill="none"
        stroke="currentColor" strokeWidth={2} strokeLinecap="round">
        <rect x="3.5" y="5" width="17" height="16" rx="2.5" />
        <path d="M8 3v4M16 3v4M3.5 10h17" />
      </svg>
      {formatShortDay(task.due_on, locale)}
      {task.is_overdue && <span className="sr-only">{t.tasks.overdue}</span>}
    </span>
  );
}

export function TaskCard({
  task, onOpen, onDragStart, onDropOn, showAssignee,
}: {
  task: TaskRow;
  onOpen: () => void;
  onDragStart: () => void;
  onDropOn: () => void;
  showAssignee: boolean;
}) {
  const { t } = useI18n();
  const [over, setOver] = useState(false);

  return (
    <li
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        // Without this the column below also handles the drop, and the card
        // lands at the end instead of where it was dropped.
        e.stopPropagation();
        e.preventDefault();
        setOver(false);
        onDropOn();
      }}
      className={cx(
        'relative overflow-hidden rounded-tile border border-border bg-surface shadow-card',
        'transition-[box-shadow,border-color,transform] duration-150 ease-soft',
        'hover:shadow-raised',
        over && 'border-accent ring-2 ring-accent/25',
        task.status === 'done' && 'opacity-75',
      )}
    >
      <ProjectStripe colour={task.project_colour} />

      <button
        type="button"
        onClick={onOpen}
        className="block w-full cursor-pointer px-3.5 py-3 text-start ps-4"
      >
        <p
          className={cx(
            'text-sm leading-snug font-medium text-ink',
            task.status === 'done' && 'line-through decoration-ink-faint',
          )}
        >
          {task.title}
        </p>

        <span className="mt-2 flex flex-wrap items-center gap-1.5">
          <ProjectChip name={task.project_key} colour={task.project_colour} />
          <PriorityBadge priority={task.priority} />
          <DueDate task={task} />
        </span>

        <span className="mt-2 flex flex-wrap items-center justify-between gap-2">
          {showAssignee && (
            <span className="truncate text-xs text-ink-muted">
              {task.assignee_name ?? t.tasks.unassigned}
            </span>
          )}
          <span className="ms-auto flex items-center gap-2 text-xs text-ink-faint">
            {task.minutes > 0 && <Duration minutes={task.minutes} />}
            {task.is_running && task.running_since && (
              <span className="inline-flex items-center gap-1 font-medium text-ok">
                <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" />
                <Elapsed since={task.running_since} />
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

function Column({
  status, tasks, onOpen, onDragStart, onDropInColumn, onDropOnCard, onAdd, showAssignee, mayAdd,
}: {
  status: TaskStatus;
  tasks: TaskRow[];
  onOpen: (task: TaskRow) => void;
  onDragStart: (task: TaskRow) => void;
  onDropInColumn: (status: TaskStatus) => void;
  onDropOnCard: (status: TaskStatus, after: TaskRow) => void;
  onAdd: (status: TaskStatus) => void;
  showAssignee: boolean;
  mayAdd: boolean;
}) {
  const { t } = useI18n();
  const label = useStatusLabel();
  const [over, setOver] = useState(false);

  return (
    <section
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onDropInColumn(status); }}
      className={cx(
        'flex min-w-0 flex-col rounded-card border bg-surface-2/60 transition-colors duration-150',
        over ? 'border-accent bg-accent-soft/40' : 'border-border',
      )}
    >
      <header className="flex items-center justify-between gap-2 px-3.5 py-3">
        <h2 className="flex items-center gap-2 text-xs font-semibold tracking-wide text-ink-muted uppercase">
          {label(status)}
          <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[0.6875rem] font-medium tnum text-ink-muted">
            {tasks.length}
          </span>
        </h2>
        {mayAdd && status !== 'done' && (
          <button
            type="button"
            onClick={() => onAdd(status)}
            aria-label={t.tasks.addTask}
            className="grid h-6 w-6 place-items-center rounded-chip text-lg leading-none text-ink-faint transition-colors hover:bg-surface-3 hover:text-ink"
          >
            +
          </button>
        )}
      </header>

      <ul className="flex min-h-24 flex-1 flex-col gap-2 px-2.5 pb-2.5">
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            showAssignee={showAssignee}
            onOpen={() => onOpen(task)}
            onDragStart={() => onDragStart(task)}
            onDropOn={() => onDropOnCard(status, task)}
          />
        ))}
        {tasks.length === 0 && (
          <li className="grid flex-1 place-items-center rounded-tile border border-dashed border-border px-3 py-6 text-center text-xs text-ink-faint">
            {over ? t.tasks.dropHere : t.tasks.emptyColumn}
          </li>
        )}
      </ul>
    </section>
  );
}

export function TaskBoard({
  tasks, onOpen, onMove, onAdd, showAssignee, mayAdd, columns = TASK_COLUMNS,
}: {
  tasks: TaskRow[];
  /** Cancelled work is off the board unless somebody asks for it. */
  columns?: TaskStatus[];
  onOpen: (task: TaskRow) => void;
  /** `after` is the card it should land below; null means the top. */
  onMove: (task: TaskRow, status: TaskStatus, after: TaskRow | null) => void;
  onAdd: (status: TaskStatus) => void;
  showAssignee: boolean;
  mayAdd: boolean;
}) {
  const [dragging, setDragging] = useState<TaskRow | null>(null);

  const byStatus = (s: TaskStatus) =>
    tasks.filter((t) => t.status === s).sort((a, b) => a.position - b.position);

  function dropInColumn(status: TaskStatus) {
    if (!dragging) return;
    // Dropped on the column rather than on a card: the end of the pile.
    const column = byStatus(status).filter((t) => t.id !== dragging.id);
    onMove(dragging, status, column[column.length - 1] ?? null);
    setDragging(null);
  }

  function dropOnCard(status: TaskStatus, after: TaskRow) {
    if (!dragging || dragging.id === after.id) { setDragging(null); return; }
    onMove(dragging, status, after);
    setDragging(null);
  }

  return (
    <div className={cx('grid gap-3', columns.length > 3 ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>
      {columns.map((status) => (
        <Column
          key={status}
          status={status}
          tasks={byStatus(status)}
          onOpen={onOpen}
          onDragStart={setDragging}
          onDropInColumn={dropInColumn}
          onDropOnCard={dropOnCard}
          onAdd={onAdd}
          showAssignee={showAssignee}
          mayAdd={mayAdd}
        />
      ))}
    </div>
  );
}

/**
 * What is running right now, and the day so far.
 *
 * The one thing a person needs to see the instant the page opens: whether the
 * clock is on, and how much of their day is accounted for. Everything else on
 * this screen can be scrolled to.
 */
export function TimerStrip({
  runningTask, minutesToday, targetMinutes, onStop, busy,
}: {
  runningTask: TaskRow | null;
  minutesToday: number;
  targetMinutes: number;
  onStop: () => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  const pct = targetMinutes > 0
    ? Math.min(100, Math.round((minutesToday / targetMinutes) * 100))
    : 0;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-4 rounded-card border border-border bg-surface p-4 shadow-card">
      {runningTask && runningTask.running_since ? (
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span aria-hidden className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok/60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-ok" />
          </span>
          <div className="min-w-0">
            <p className="text-xs text-ink-faint">{t.tasks.runningOn}</p>
            <p className="truncate text-sm font-medium text-ink">{runningTask.title}</p>
          </div>
          <p className="ms-auto font-display text-xl font-semibold text-ok display-tight">
            <Elapsed since={runningTask.running_since} />
          </p>
          <Button variant="danger" onClick={onStop} disabled={busy}>{t.tasks.stop}</Button>
        </div>
      ) : (
        <p className="flex-1 text-sm text-ink-faint">{t.tasks.noTimer}</p>
      )}

      <div className="min-w-44 flex-1">
        <p className="flex items-baseline justify-between gap-2 text-xs">
          <span className="text-ink-muted">{t.tasks.todayWorked}</span>
          <span className="text-ink-faint">
            <Duration minutes={minutesToday} /> {t.tasks.ofTarget} <Duration minutes={targetMinutes} />
          </span>
        </p>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
          <div
            className={cx('h-full rounded-full transition-[width] duration-500 ease-soft',
              pct >= 100 ? 'bg-ok' : 'brand-ramp')}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
