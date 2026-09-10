'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useAccess } from '@/lib/access/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { createClient } from '@/lib/supabase/client';
import { dbErrorText } from '@/lib/db-errors';
import {
  Button, Card, Checkbox, EmptyState, ErrorState, Input, Notice, PageHeader,
  PageSkeleton, Select, cx,
} from '@/components/ui/primitives';
import { TASK_COLUMNS, TaskTabs, useTaskReason } from '@/components/tasks/parts';
import { TaskBoard, TimerStrip } from '@/components/tasks/board';
import { NewTaskModal, TaskModal } from '@/components/tasks/dialogs';
import { MyDay } from '@/components/tasks/summary';
import type {
  ProductivityRow, ProjectRow, TaskResult, TaskRow, TaskSessionRow, TaskStatus,
} from '@/types/database';

/**
 * The board.
 *
 * It opens on YOUR work, always — even for the owner, who can see everyone's.
 * A board that opens on forty cards belonging to five people is a report; a
 * board that opens on yours is a place to start the day. The team is one click
 * away for anybody allowed to look.
 *
 * Row visibility is not this file's job. RLS decides which tasks come back,
 * and the "whole team" switch is a filter on what the database already agreed
 * to send — so a person without `team.read` who flips it sees exactly what
 * they saw before.
 */
export default function TasksPage() {
  const { t } = useI18n();
  const { can, user_id, full_name, email } = useAccess();
  const mayWork = can('tasks.write') || can('team.write');
  const mayManage = can('team.write');
  const maySeeTeam = can('team.read');
  const reasonText = useTaskReason();

  /*
   * Null until somebody chooses, so the default can depend on data that has
   * not arrived yet: an account with no roster row has no work of its own, and
   * opening it on an empty "شغلي" would be a blank screen with no explanation.
   */
  const [scope, setScope] = useState<'mine' | 'all' | null>(null);
  const [projectId, setProjectId] = useState('');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState<TaskStatus | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tasks = useSupabaseQuery<TaskRow[]>(
    (sb) => {
      const q = sb.from('v_tasks').select('*').order('position');
      return showCancelled ? q : q.neq('status', 'cancelled');
    },
    [showCancelled],
  );
  const projects = useSupabaseQuery<ProjectRow[]>(
    (sb) => sb.from('v_projects').select('*').order('sort_order').order('name'), [],
  );
  // Doubles as the people picker and as "which employee am I", since the view
  // returns exactly one row — your own — to anybody without `team.read`.
  const people = useSupabaseQuery<ProductivityRow[]>(
    (sb) => sb.from('v_team_productivity').select('*').order('full_name'), [],
  );
  const sessions = useSupabaseQuery<TaskSessionRow[]>(
    (sb) => (openId
      ? sb.from('v_task_sessions').select('*').eq('task_id', openId)
        .order('started_at', { ascending: false })
      : Promise.resolve({ data: [] as TaskSessionRow[], error: null })),
    [openId ?? ''],
  );

  function reloadAll() { tasks.reload(); people.reload(); sessions.reload(); }

  const peopleRows = people.data ?? [];
  /*
   * The signed-in person's own employee row, if they have one.
   *
   * Matched on `user_id` rather than asked for separately: with `team.read`
   * this view returns everybody and without it exactly one row, so the same
   * lookup works for the owner and for a salesperson. Null is a real answer —
   * somebody can hold `tasks.write` and simply not be on the payroll list,
   * which is what the notice below the header is for.
   */
  const me = peopleRows.find((p) => p.user_id !== null && p.user_id === user_id) ?? null;

  // Somebody who is not on the roster has no work of their own to show, so
  // they start on the team's — if they may see it at all.
  const effectiveScope: 'mine' | 'all' = scope ?? (me === null && maySeeTeam ? 'all' : 'mine');

  const allTasks = tasks.data ?? [];
  const visible = allTasks.filter((task) => {
    /*
     * "Mine" means assigned to me.
     *
     * This read `scope === 'mine' && me && …` — a null guard that quietly
     * turned the whole filter OFF for anybody without a roster row, so the
     * owner opened "شغلي" and saw the entire team's board. A missing "me" is
     * not a reason to show everything; it is a reason to show nothing.
     */
    if (effectiveScope === 'mine' && (me === null || task.assignee_id !== me.id)) return false;
    if (projectId && task.project_id !== projectId) return false;
    if (search.trim() !== '') {
      const q = search.trim().toLowerCase();
      if (!task.title.toLowerCase().includes(q)
        && !(task.project_name ?? '').toLowerCase().includes(q)
        && !(task.assignee_name ?? '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const openTask = allTasks.find((task) => task.id === openId) ?? null;
  /*
   * Where MY clock is, not which of my tasks has a clock on it.
   *
   * Those differ the moment two people share a task, and the strip is about
   * the reader's own running timer.
   */
  const running = allTasks.find(
    (task) => me !== null && task.running_employee_id === me.id) ?? null;

  async function move(task: TaskRow, status: TaskStatus, after: TaskRow | null) {
    setBusy(true);
    setError(null);
    const { data, error: err } = await createClient().rpc('move_task', {
      p_task_id: task.id, p_status: status, p_after_id: after?.id ?? null,
    });
    setBusy(false);
    if (err) { setError(dbErrorText(err, t)); return; }
    const result = data as TaskResult | null;
    if (!result?.ok) { setError(reasonText(result?.reason)); return; }
    tasks.reload();
  }

  async function stopTimer() {
    setBusy(true);
    setError(null);
    const { data, error: err } = await createClient().rpc('stop_task_timer', { p_note: null });
    setBusy(false);
    if (err) { setError(dbErrorText(err, t)); return; }
    const result = data as TaskResult | null;
    if (!result?.ok) { setError(reasonText(result?.reason)); return; }
    reloadAll();
  }

  if (tasks.loading && allTasks.length === 0) return <PageSkeleton label={t.tasks.title} />;
  if (tasks.error) return <ErrorState message={t.common.error} detail={tasks.error} />;

  return (
    <>
      <PageHeader
        eyebrow={t.navGroups.work}
        title={t.tasks.title}
        subtitle={t.tasks.subtitle}
        action={mayWork
          ? <Button onClick={() => setAdding('todo')}>{t.tasks.addTask}</Button>
          : undefined}
      />
      <TaskTabs maySeeTeam={maySeeTeam} />

      {/*
        * A message about a gap somebody else has to close.
        *
        * This account has no `employees` row, so it can neither be given a
        * task nor run a timer. Three different people can be reading that
        * sentence, and only one of them can do anything about it:
        *
        *   - a manager watching the team, who does not need a payroll row at
        *     all. Told nothing; the Start button needs one and is simply not
        *     offered, and nagging them daily about a thing they never asked
        *     for is noise.
        *   - the owner, who can fix it. Told where to go.
        *   - the employee, who CANNOT — Payroll needs `payroll.write`. The
        *     first version of this sent them to a page they cannot open,
        *     which is worse than saying nothing. They get the fact and who to
        *     ask, and the real fix is one click on the Staff screen.
        */}
      {mayWork && me === null && !maySeeTeam && (
        <div className="mb-4">
          <Notice tone={can('payroll.write') ? 'warn' : 'info'}>
            {can('payroll.write') ? t.tasks.notLinkedNotice : t.tasks.notLinkedForYou}
          </Notice>
        </div>
      )}

      {me && <MyDay me={me} name={full_name ?? email ?? null} />}

      {me && (
        <TimerStrip
          runningTask={running}
          minutesToday={me.minutes_today}
          targetMinutes={me.daily_target_minutes}
          onStop={() => void stopTimer()}
          busy={busy}
        />
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {maySeeTeam && (
          <div
            role="radiogroup"
            aria-label={t.tasks.title}
            className="flex items-center gap-0.5 rounded-full border border-border bg-surface-2 p-0.5"
          >
            {(['mine', 'all'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={effectiveScope === value}
                onClick={() => setScope(value)}
                className={cx(
                  'rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors',
                  effectiveScope === value
                    ? 'bg-surface text-brand shadow-card'
                    : 'text-ink-muted hover:text-ink',
                )}
              >
                {value === 'mine' ? t.tasks.mine : t.tasks.everyone}
              </button>
            ))}
          </div>
        )}

        <Select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="w-auto min-w-40"
        >
          <option value="">{t.tasks.project}: {t.common.all}</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>

        <Checkbox
          checked={showCancelled}
          onChange={setShowCancelled}
          label={t.tasks.showCancelled}
        />

        <Input
          value={search}
          placeholder={t.common.search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-auto min-w-48 flex-1"
        />
      </div>

      {error && <div className="mb-3"><Notice tone="danger">{error}</Notice></div>}

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            message={effectiveScope === 'mine' && me === null
              ? t.tasks.emptyNotOnRoster
              : effectiveScope === 'mine' && allTasks.length > 0
                ? t.tasks.emptyMine
                : mayManage ? t.tasks.emptyBoardManager : t.tasks.emptyBoard}
            action={mayWork
              ? <Button onClick={() => setAdding('todo')}>{t.tasks.addTask}</Button>
              : undefined}
          />
        </Card>
      ) : (
      <TaskBoard
        tasks={visible}
        showAssignee={effectiveScope === 'all'}
        columns={showCancelled ? [...TASK_COLUMNS, 'cancelled'] : TASK_COLUMNS}
        mayAdd={mayWork}
        onOpen={(task) => setOpenId(task.id)}
        onMove={(task, status, after) => void move(task, status, after)}
        onAdd={(status) => setAdding(status)}
      />
      )}

      {openTask && (
        <TaskModal
          key={openTask.id}
          open
          task={openTask}
          projects={projects.data ?? []}
          people={peopleRows}
          sessions={sessions.data ?? []}
          mayManage={mayManage}
          mayWork={mayWork}
          myEmployeeId={me?.id ?? null}
          onClose={() => setOpenId(null)}
          onChanged={reloadAll}
        />
      )}

      {adding && (
        <NewTaskModal
          open
          projects={projects.data ?? []}
          people={peopleRows}
          defaultStatus={adding}
          defaultAssignee={me?.id ?? null}
          mayManage={mayManage}
          onClose={() => setAdding(null)}
          onCreated={reloadAll}
        />
      )}
    </>
  );
}
