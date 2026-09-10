'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useAccess } from '@/lib/access/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { formatNumber } from '@/lib/format';
import {
  Badge, Button, Card, EmptyState, ErrorState, PageHeader, PageSkeleton, cx,
} from '@/components/ui/primitives';
import {
  Duration, PROJECT_COLOURS, ProjectStripe, TaskTabs,
} from '@/components/tasks/parts';
import {
  CreateRecordModal, DeleteRecordDialog, EditRecordModal, RecordActions,
  type FieldSpec,
} from '@/components/record-actions';
import type { ProjectRow } from '@/types/database';

/**
 * What the work is filed under.
 *
 * The card is a progress bar and four numbers, because the only question
 * anybody brings to this screen is "how far along is that". The colour is not
 * decoration either — it is the stripe every card of this project carries on
 * the board, so picking it here is picking how the board reads.
 */
export default function ProjectsPage() {
  const { t, locale } = useI18n();
  const { can } = useAccess();
  const mayWrite = can('team.write');

  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const projects = useSupabaseQuery<ProjectRow[]>(
    (sb) => sb.from('v_projects').select('*')
      .order('is_active', { ascending: false }).order('sort_order').order('name'),
    [],
  );

  const rows = projects.data ?? [];
  const editing = rows.find((p) => p.id === editingId) ?? null;

  const fields: FieldSpec[] = [
    { name: 'name', label: t.tasks.projectName, type: 'text', required: true },
    { name: 'key', label: t.tasks.projectKey, type: 'text', hint: t.tasks.projectKeyHint },
    { name: 'description', label: t.tasks.description, type: 'textarea' },
    {
      name: 'colour',
      label: t.tasks.colour,
      type: 'select',
      options: PROJECT_COLOURS.map((c) => ({ value: c, label: c })),
    },
    { name: 'sort_order', label: t.payroll.sortOrder, type: 'number' },
    { name: 'is_active', label: t.payroll.activeLabel, type: 'checkbox' },
  ];

  if (projects.loading && rows.length === 0) return <PageSkeleton label={t.tasks.projects} />;
  if (projects.error) return <ErrorState message={t.common.error} detail={projects.error} />;

  return (
    <>
      <PageHeader
        eyebrow={t.navGroups.work}
        title={t.tasks.title}
        subtitle={t.tasks.subtitle}
        action={mayWrite
          ? <Button onClick={() => setCreating(true)}>{t.tasks.addProject}</Button>
          : undefined}
      />
      <TaskTabs maySeeTeam={can('team.read')} />

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            message={t.tasks.noProjects}
            action={mayWrite
              ? <Button onClick={() => setCreating(true)}>{t.tasks.addProject}</Button>
              : undefined}
          />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((p) => (
            <Card key={p.id} className={cx('relative overflow-hidden p-4', !p.is_active && 'opacity-60')}>
              <ProjectStripe colour={p.colour} />
              <div className="ps-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-display font-semibold text-ink display-tight">
                        {p.name}
                      </span>
                      <Badge tone="neutral">{p.key}</Badge>
                      {!p.is_active && <Badge tone="neutral">{t.records.archived}</Badge>}
                    </p>
                    {p.description && (
                      <p className="mt-1 line-clamp-2 text-xs text-ink-faint">{p.description}</p>
                    )}
                  </div>
                  <RecordActions
                    archived={!p.is_active}
                    onEdit={mayWrite ? () => setEditingId(p.id) : undefined}
                    onDelete={mayWrite ? () => setDeletingId(p.id) : undefined}
                  />
                </div>

                <p className="mt-3 flex items-baseline justify-between gap-2 text-xs">
                  <span className="text-ink-muted">
                    {formatNumber(p.tasks, locale)} {t.tasks.tasksCount}
                  </span>
                  <span className="font-display font-semibold tnum text-ink">
                    {formatNumber(p.percent_done, locale)}% {t.tasks.complete}
                  </span>
                </p>
                <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-3">
                  <div
                    className={cx('h-full rounded-full transition-[width] duration-500 ease-soft',
                      p.percent_done >= 100 ? 'bg-ok' : 'brand-ramp')}
                    style={{ width: `${p.percent_done}%` }}
                  />
                </div>

                <p className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
                  <span>{t.tasks.todo}: {formatNumber(p.todo, locale)}</span>
                  <span>{t.tasks.inProgress}: {formatNumber(p.in_progress, locale)}</span>
                  <span>{t.tasks.done}: {formatNumber(p.done, locale)}</span>
                  {p.overdue > 0 && (
                    <span className="font-medium text-danger">
                      {t.tasks.overdue}: {formatNumber(p.overdue, locale)}
                    </span>
                  )}
                  {p.minutes > 0 && (
                    <span className="ms-auto">
                      <Duration minutes={p.minutes} /> {t.tasks.minutesTracked}
                    </span>
                  )}
                </p>
              </div>
            </Card>
          ))}
        </div>
      )}

      {creating && (
        <CreateRecordModal
          open
          onClose={() => setCreating(false)}
          table="projects"
          fields={fields}
          values={{ is_active: true, sort_order: 100, colour: 'brand' }}
          title={t.tasks.addProject}
          onSaved={() => projects.reload()}
        />
      )}

      {editing && (
        <EditRecordModal
          open
          onClose={() => setEditingId(null)}
          table="projects"
          id={editing.id}
          fields={fields}
          values={editing as unknown as Record<string, unknown>}
          title={t.records.edit}
          onSaved={() => projects.reload()}
        />
      )}

      <DeleteRecordDialog
        kind="project"
        id={deletingId}
        open={deletingId !== null}
        onClose={() => setDeletingId(null)}
        onDone={() => projects.reload()}
      />
    </>
  );
}
