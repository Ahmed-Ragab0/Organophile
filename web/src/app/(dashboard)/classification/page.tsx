'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useAccess } from '@/lib/access/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { Button, Card, CardHeader, Notice, PageHeader } from '@/components/ui/primitives';
import {
  CreateRecordModal, DeleteRecordDialog, EditRecordModal, RecordActions,
  type FieldSpec, type RecordKind,
} from '@/components/record-actions';
import type { Track, University } from '@/types/database';

type Counted = University & { courses: number; students: number };

/**
 * The two lists a student and a course are classified by.
 *
 * They live on one screen because they are the same kind of thing and are
 * almost always edited together: a new university arrives with the tracks it
 * teaches. Everywhere else in the app these are a dropdown; this is where the
 * dropdown's contents are decided.
 */
/**
 * One list, twice. Hoisted out of the page rather than nested inside it: a
 * component redeclared on every render is a different component every render,
 * and React remounts it.
 */
function ClassificationList({
  title, rows, addLabel, empty, loading, mayWrite, onAdd, onEdit, onDelete,
}: {
  title: string;
  rows: Counted[];
  addLabel: string;
  empty: string;
  loading: boolean;
  /** Read-only roles see the list; the verbs are simply not there. */
  mayWrite: boolean;
  onAdd: () => void;
  onEdit: (row: Counted) => void;
  onDelete: (row: Counted) => void;
}) {
  const { t } = useI18n();
  return (
    <Card>
      <CardHeader
        title={title}
        hint={`${rows.length} ${t.common.rows}`}
        action={mayWrite
          ? <Button size="sm" variant="secondary" onClick={onAdd}>{addLabel}</Button>
          : undefined}
      />
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
            <div className="min-w-0">
              <p className="truncate font-medium text-ink">{r.name}</p>
              <p className="mt-0.5 text-xs text-ink-faint tnum">
                {r.courses} {t.classification.coursesCount}
                {' · '}
                {r.students} {t.classification.studentsCount}
              </p>
            </div>
            <RecordActions
              archived={!r.is_active}
              onEdit={mayWrite ? () => onEdit(r) : undefined}
              onDelete={mayWrite ? () => onDelete(r) : undefined}
            />
          </li>
        ))}
        {rows.length === 0 && (
          <li className="px-5 py-10 text-center text-sm text-ink-faint">
            {loading ? t.common.loading : empty}
          </li>
        )}
      </ul>
    </Card>
  );
}

export default function ClassificationPage() {
  const { t } = useI18n();
  const { can } = useAccess();
  const mayWrite = can('courses.write');
  const [creating, setCreating] = useState<RecordKind | null>(null);
  const [editing, setEditing] = useState<
    { kind: RecordKind; id: string; values: Record<string, unknown> } | null>(null);
  const [deleting, setDeleting] = useState<{ kind: RecordKind; id: string } | null>(null);

  const universities = useSupabaseQuery<University[]>(
    (sb) => sb.from('universities').select('*').order('name'), [],
  );
  const tracks = useSupabaseQuery<Track[]>(
    (sb) => sb.from('tracks').select('*').order('name'), [],
  );
  // The counts are what make a delete decision possible before it is made, so
  // they are read here rather than left to the dialog alone.
  const courses = useSupabaseQuery<Array<{ university_id: string | null; track_id: string | null }>>(
    (sb) => sb.from('courses').select('university_id, track_id'), [],
  );
  const students = useSupabaseQuery<Array<{ university_id: string | null; track_id: string | null }>>(
    (sb) => sb.from('students').select('university_id, track_id'), [],
  );

  function reloadAll() {
    universities.reload(); tracks.reload(); courses.reload(); students.reload();
  }

  function counted(rows: University[] | null, key: 'university_id' | 'track_id'): Counted[] {
    return (rows ?? []).map((r) => ({
      ...r,
      courses: (courses.data ?? []).filter((c) => c[key] === r.id).length,
      students: (students.data ?? []).filter((s) => s[key] === r.id).length,
    }));
  }

  const fieldsFor: Record<string, FieldSpec[]> = {
    university: [
      { name: 'name', label: t.classification.universityName, type: 'text', required: true },
      { name: 'is_active', label: t.classification.activeLabel, type: 'checkbox' },
    ],
    track: [
      { name: 'name', label: t.classification.trackName, type: 'text', required: true },
      { name: 'is_active', label: t.classification.activeLabel, type: 'checkbox' },
    ],
  };

  return (
    <>
      <PageHeader
        eyebrow={t.navGroups.people}
        title={t.classification.title}
        subtitle={t.classification.subtitle}
      />

      <div className="mb-4 space-y-2">
        <Notice tone="info">{t.classification.autoNote}</Notice>
        <Notice tone="ok">{t.classification.renameNote}</Notice>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ClassificationList
          title={t.classification.universities}
          rows={counted(universities.data, 'university_id')}
          addLabel={t.classification.addUniversity}
          empty={t.classification.emptyUniversities}
          loading={universities.loading}
          mayWrite={mayWrite}
          onAdd={() => setCreating('university')}
          onEdit={(r) => setEditing({
            kind: 'university', id: r.id, values: r as unknown as Record<string, unknown>,
          })}
          onDelete={(r) => setDeleting({ kind: 'university', id: r.id })}
        />
        <ClassificationList
          title={t.classification.tracks}
          rows={counted(tracks.data, 'track_id')}
          addLabel={t.classification.addTrack}
          empty={t.classification.emptyTracks}
          loading={tracks.loading}
          mayWrite={mayWrite}
          onAdd={() => setCreating('track')}
          onEdit={(r) => setEditing({
            kind: 'track', id: r.id, values: r as unknown as Record<string, unknown>,
          })}
          onDelete={(r) => setDeleting({ kind: 'track', id: r.id })}
        />
      </div>

      {creating && (
        <CreateRecordModal
          open
          onClose={() => setCreating(null)}
          table={creating === 'university' ? 'universities' : 'tracks'}
          values={{ is_active: true }}
          fields={fieldsFor[creating]}
          title={creating === 'university'
            ? t.classification.addUniversity
            : t.classification.addTrack}
          onSaved={reloadAll}
        />
      )}

      {editing && (
        <EditRecordModal
          open
          onClose={() => setEditing(null)}
          table={editing.kind === 'university' ? 'universities' : 'tracks'}
          id={editing.id}
          fields={fieldsFor[editing.kind]}
          values={editing.values}
          title={t.records.edit}
          onSaved={reloadAll}
        />
      )}

      <DeleteRecordDialog
        kind={deleting?.kind ?? 'university'}
        id={deleting?.id ?? null}
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onDone={reloadAll}
      />
    </>
  );
}
