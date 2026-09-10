'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useAccess } from '@/lib/access/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { createClient } from '@/lib/supabase/client';
import { dbErrorText } from '@/lib/db-errors';
import { formatDate } from '@/lib/format';
import {
  Badge, Button, Card, CardHeader, Checkbox, cx, Field, Input, Modal, Notice,
  PageHeader, Select, Textarea,
} from '@/components/ui/primitives';
import type { PermissionRow, RoleRow, StaffRow } from '@/types/database';

/**
 * Who gets in, and what they can do.
 *
 * Two lists that are read together and almost never separately: a person is
 * only ever "a role", and a role only means something because people hold it.
 * Splitting them across two screens would mean opening both to answer either
 * question.
 *
 * Creating a login is the one action here that does not go through the
 * database directly — it needs the service role key, which lives in an Edge
 * Function and nowhere else. Everything else is an ordinary write, refused by
 * RLS if this person should not be making it.
 */

type StaffError = keyof ReturnType<typeof useI18n>['t']['staffPage']['errors'];

/** POSTs to the account function and returns a code the dictionary knows. */
async function callStaffAdmin(body: Record<string, unknown>): Promise<StaffError | null> {
  const { data: session } = await createClient().auth.getSession();
  const token = session.session?.access_token;
  if (!token) return 'forbidden';

  const res = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/staff-admin`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );

  if (res.ok) return null;
  const payload = await res.json().catch(() => null) as { error?: string } | null;
  return (payload?.error ?? 'unknown') as StaffError;
}

/* ─────────────────────────────────────────────────────────── add a person ── */

function AddPersonModal({
  open, onClose, roles, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  roles: RoleRow[];
  onSaved: () => void;
}) {
  const { t, locale } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [roleId, setRoleId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StaffError | null>(null);

  const usable = roles.filter((r) => r.is_active);
  const effectiveRole = roleId || usable[0]?.id || '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const failure = await callStaffAdmin({
      action: 'create',
      email, password, role_id: effectiveRole,
      full_name: fullName || null,
      phone: phone || null,
      note: note || null,
    });
    setBusy(false);
    if (failure) { setError(failure); return; }
    setEmail(''); setPassword(''); setFullName(''); setPhone(''); setNote('');
    onSaved();
    onClose();
  }

  if (!open) return null;

  return (
    <Modal open onClose={onClose} title={t.staffPage.createTitle}>
      <form onSubmit={submit} className="space-y-3">
        <Notice tone="info">{t.staffPage.createHint}</Notice>

        <Field label={`${t.staffPage.email} *`}>
          <Input
            type="email" dir="ltr" required autoComplete="off"
            value={email} onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        <Field label={`${t.staffPage.password} *`} hint={t.staffPage.passwordHint}>
          <Input
            type="text" dir="ltr" required minLength={8} autoComplete="new-password"
            value={password} onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.staffPage.fullName}>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </Field>
          <Field label={t.staffPage.phone}>
            <Input dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
        </div>

        <Field label={`${t.staffPage.role} *`}>
          <Select
            value={effectiveRole}
            required
            onChange={(e) => setRoleId(e.target.value)}
          >
            {usable.map((r) => (
              <option key={r.id} value={r.id}>
                {locale === 'en' ? (r.name_en ?? r.name) : r.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={`${t.staffPage.note} (${t.common.optional})`}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        {error && <Notice tone="danger">{t.staffPage.errors[error] ?? t.common.error}</Notice>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
          <Button type="submit" disabled={busy}>{busy ? t.common.saving : t.common.save}</Button>
        </div>
      </form>
    </Modal>
  );
}

/* ─────────────────────────────────────────────────────────── edit a person ─ */

function EditPersonModal({
  person, roles, onClose, onSaved,
}: {
  person: StaffRow | null;
  roles: RoleRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, locale } = useI18n();
  const [fullName, setFullName] = useState(person?.full_name ?? '');
  const [phone, setPhone] = useState(person?.phone ?? '');
  const [roleId, setRoleId] = useState(person?.role_id ?? '');
  const [note, setNote] = useState(person?.note ?? '');
  const [active, setActive] = useState(person?.is_active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openedFor, setOpenedFor] = useState<string | null>(null);

  if (person && openedFor !== person.user_id) {
    setOpenedFor(person.user_id);
    setFullName(person.full_name ?? '');
    setPhone(person.phone ?? '');
    setRoleId(person.role_id);
    setNote(person.note ?? '');
    setActive(person.is_active);
    setError(null);
  }
  if (!person && openedFor !== null) setOpenedFor(null);

  if (!person) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!person) return;
    setBusy(true);
    setError(null);
    const { error: err } = await createClient().from('staff').update({
      full_name: fullName || null,
      phone: phone || null,
      note: note || null,
      role_id: roleId,
      is_active: active,
    }).eq('user_id', person.user_id);
    setBusy(false);
    if (err) {
      // The refusal comes from a trigger and already says what happened; the
      // dictionary only translates the two a person can actually trip.
      const m = err.message.toLowerCase();
      setError(
        m.includes('last administrator') ? t.staffPage.errors.last_admin
        : m.includes('your own') ? t.staffPage.errors.self_change
        : err.message,
      );
      return;
    }
    onSaved();
    onClose();
  }

  return (
    <Modal open onClose={onClose} title={t.staffPage.editTitle}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-ink-muted" dir="ltr">{person.email}</p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.staffPage.fullName}>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </Field>
          <Field label={t.staffPage.phone}>
            <Input dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
        </div>

        <Field label={t.staffPage.role}>
          <Select
            value={roleId}
            disabled={person.is_me}
            onChange={(e) => setRoleId(e.target.value)}
          >
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {locale === 'en' ? (r.name_en ?? r.name) : r.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={`${t.staffPage.note} (${t.common.optional})`}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        {/* Your own row keeps its role and its switch disabled. The database
            refuses both anyway; greying them out is what stops someone
            discovering that by being told no. */}
        <Checkbox
          label={t.staffPage.active}
          checked={active}
          disabled={person.is_me}
          onChange={setActive}
        />
        {person.is_me && <p className="text-xs text-ink-faint">{t.staffPage.errors.self_change}</p>}

        {error && <Notice tone="danger">{error}</Notice>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
          <Button type="submit" disabled={busy}>{busy ? t.common.saving : t.common.save}</Button>
        </div>
      </form>
    </Modal>
  );
}

/* ────────────────────────────────────────────────────────────── password ─── */

function PasswordModal({
  person, onClose,
}: {
  person: StaffRow | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StaffError | null>(null);
  const [done, setDone] = useState(false);

  if (!person) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!person) return;
    setBusy(true);
    setError(null);
    const failure = await callStaffAdmin({
      action: 'set_password', user_id: person.user_id, password,
    });
    setBusy(false);
    if (failure) { setError(failure); return; }
    setPassword('');
    setDone(true);
  }

  return (
    <Modal open onClose={onClose} title={t.staffPage.resetTitle}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-ink-muted" dir="ltr">{person.email}</p>
        <Notice tone="warn">{t.staffPage.resetHint}</Notice>

        <Field label={`${t.staffPage.newPassword} *`} hint={t.staffPage.passwordHint}>
          <Input
            type="text" dir="ltr" required minLength={8} autoComplete="new-password"
            value={password} onChange={(e) => { setPassword(e.target.value); setDone(false); }}
          />
        </Field>

        {error && <Notice tone="danger">{t.staffPage.errors[error] ?? t.common.error}</Notice>}
        {done && <Notice tone="ok">{t.staffPage.savedPassword}</Notice>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t.common.close}</Button>
          <Button type="submit" disabled={busy}>{busy ? t.common.saving : t.common.save}</Button>
        </div>
      </form>
    </Modal>
  );
}

/* ───────────────────────────────────────────────────────────────── remove ── */

function RemovePersonDialog({
  person, onClose, onDone,
}: {
  person: StaffRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StaffError | null>(null);

  if (!person) return null;

  async function run() {
    if (!person) return;
    setBusy(true);
    setError(null);
    const failure = await callStaffAdmin({ action: 'remove', user_id: person.user_id });
    setBusy(false);
    if (failure) { setError(failure); return; }
    onDone();
    onClose();
  }

  return (
    <Modal open onClose={onClose} title={t.staffPage.removeTitle}>
      <div className="space-y-4">
        <p className="text-sm text-ink">
          <strong>{person.full_name || person.email}</strong>
        </p>
        <Notice tone="danger">{t.staffPage.removeHint}</Notice>
        {error && <Notice tone="danger">{t.staffPage.errors[error] ?? t.common.error}</Notice>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
          <Button variant="danger" onClick={run} disabled={busy}>
            {busy ? t.common.saving : t.staffPage.remove}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ────────────────────────────────────────────────────────────────── roles ── */

function RoleModal({
  role, permissions, onClose, onSaved,
}: {
  /** null creates a new role. undefined means the modal is shut. */
  role: RoleRow | null | undefined;
  permissions: PermissionRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, locale } = useI18n();
  const [name, setName] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [description, setDescription] = useState('');
  const [held, setHeld] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openedFor, setOpenedFor] = useState<string | null>(null);

  const key = role === undefined ? null : (role?.id ?? '__new__');
  if (key !== null && openedFor !== key) {
    setOpenedFor(key);
    setName(role?.name ?? '');
    setNameEn(role?.name_en ?? '');
    setDescription(role?.description ?? '');
    setHeld(role?.permissions ?? []);
    setError(null);
  }
  if (key === null && openedFor !== null) setOpenedFor(null);

  if (role === undefined) return null;

  const superuser = role?.is_superuser ?? false;

  // Grouped by domain, in the catalogue's own order, so "can see X / can change
  // X" always sit together and the list reads as the app's own map.
  const domains: Array<{ domain: string; rows: PermissionRow[] }> = [];
  for (const p of permissions) {
    const found = domains.find((d) => d.domain === p.domain);
    if (found) found.rows.push(p);
    else domains.push({ domain: p.domain, rows: [p] });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const sb = createClient();

    let roleId = role?.id ?? null;
    if (roleId === null) {
      const { data, error: err } = await sb.from('roles')
        .insert({ name, name_en: nameEn || null, description: description || null })
        .select('id').single();
      if (err) { setBusy(false); setError(dbErrorText(err, t)); return; }
      roleId = (data as { id: string }).id;
    } else {
      const { error: err } = await sb.from('roles').update({
        name, name_en: nameEn || null, description: description || null,
      }).eq('id', roleId);
      if (err) { setBusy(false); setError(dbErrorText(err, t)); return; }
    }

    if (!superuser) {
      /*
       * Replace rather than diff. The set is at most a couple of dozen rows,
       * and a diff has to be right about both directions — an unticked box
       * that never became a delete is a permission nobody can see and nobody
       * revoked.
       */
      const { error: clearErr } = await sb.from('role_permissions')
        .delete().eq('role_id', roleId);
      if (clearErr) { setBusy(false); setError(clearErr.message); return; }

      if (held.length > 0) {
        const { error: insertErr } = await sb.from('role_permissions').insert(
          held.map((code) => ({ role_id: roleId, permission_code: code })),
        );
        if (insertErr) { setBusy(false); setError(insertErr.message); return; }
      }
    }

    setBusy(false);
    onSaved();
    onClose();
  }

  function toggle(code: string, next: boolean) {
    setHeld((current) =>
      next ? [...current, code] : current.filter((c) => c !== code));
  }

  return (
    <Modal open onClose={onClose} title={role ? t.records.edit : t.staffPage.addRole}>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`${t.staffPage.roleName} *`}>
            <Input value={name} required onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t.staffPage.roleNameEn}>
            <Input dir="ltr" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
          </Field>
        </div>

        <Field label={t.staffPage.roleDescription}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>

        {superuser ? (
          <Notice tone="info">{t.staffPage.superuserNote}</Notice>
        ) : (
          <div className="space-y-3">
            <p className="text-sm font-medium text-ink">{t.staffPage.permissions}</p>
            {domains.map((d) => (
              <div key={d.domain} className="rounded-field border border-border p-3">
                <p className="mb-2 text-xs font-semibold text-ink-muted">
                  {t.staffPage.byDomain[d.domain as keyof typeof t.staffPage.byDomain] ?? d.domain}
                </p>
                <div className="space-y-1.5">
                  {d.rows.map((p) => (
                    <Checkbox
                      key={p.code}
                      label={locale === 'en' ? (p.name_en ?? p.name) : p.name}
                      checked={held.includes(p.code)}
                      onChange={(next) => toggle(p.code, next)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {error && <Notice tone="danger">{error}</Notice>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
          <Button type="submit" disabled={busy}>{busy ? t.common.saving : t.common.save}</Button>
        </div>
      </form>
    </Modal>
  );
}

/* ─────────────────────────────────────────────────────────────────── page ── */

export default function StaffPage() {
  const { t, locale } = useI18n();
  const { can } = useAccess();
  const mayWrite = can('staff.write');
  // Creating the employee row is a payroll write, so the offer is only made to
  // somebody who could actually complete it.
  const mayPayroll = can('payroll.write');

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<StaffRow | null>(null);
  const [passwordFor, setPasswordFor] = useState<StaffRow | null>(null);
  const [removing, setRemoving] = useState<StaffRow | null>(null);
  const [enrolling, setEnrolling] = useState<string | null>(null);
  const [enrolError, setEnrolError] = useState<string | null>(null);
  const [roleModal, setRoleModal] = useState<RoleRow | null | undefined>(undefined);
  const [deletingRole, setDeletingRole] = useState<RoleRow | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);

  const people = useSupabaseQuery<StaffRow[]>(
    (sb) => sb.from('v_staff').select('*').order('created_at'), [],
  );
  const roles = useSupabaseQuery<RoleRow[]>(
    (sb) => sb.from('v_roles').select('*').order('sort_order').order('name'), [],
  );
  const permissions = useSupabaseQuery<PermissionRow[]>(
    (sb) => sb.from('permissions').select('*').order('sort_order'), [],
  );

  function reloadAll() { people.reload(); roles.reload(); }

  /**
   * Put a login on the work roster.
   *
   * An account and a person are two records on purpose — somebody paid in
   * cash has no login, and the owner has a login and no salary (0049). But
   * crossing that gap used to mean leaving this screen, opening Payroll,
   * adding a person and picking the account out of a dropdown; and until it
   * was done the account holder saw a message telling them to go do it on a
   * page they cannot open.
   *
   * The row is created bare: a name, an email and a link. No wage — being on
   * the roster is about doing work, and what somebody is paid is a separate
   * decision made on a separate screen.
   */
  async function addToRoster(person: StaffRow) {
    setEnrolling(person.user_id);
    setEnrolError(null);
    const { error: err } = await createClient().from('employees').insert({
      full_name: person.full_name?.trim() || person.email,
      email: person.email,
      user_id: person.user_id,
      base_salary: 0,
    });
    setEnrolling(null);
    if (err) { setEnrolError(dbErrorText(err, t)); return; }
    people.reload();
  }

  async function deleteRole(role: RoleRow) {
    setRoleError(null);
    const { error } = await createClient().from('roles').delete().eq('id', role.id);
    if (error) { setRoleError(error.message); return; }
    setDeletingRole(null);
    reloadAll();
  }

  const staffRows = people.data ?? [];
  const roleRows = roles.data ?? [];
  const roleName = (r: RoleRow) => (locale === 'en' ? (r.name_en ?? r.name) : r.name);

  return (
    <>
      <PageHeader
        eyebrow={t.navGroups.ops}
        title={t.staffPage.title}
        subtitle={t.staffPage.subtitle}
        action={mayWrite
          ? <Button onClick={() => setAdding(true)}>+ {t.staffPage.addPerson}</Button>
          : undefined}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title={t.staffPage.people}
            hint={`${staffRows.length} ${t.staffPage.membersCount}`}
          />
          {enrolError && (
            <div className="px-5 pt-4"><Notice tone="danger">{enrolError}</Notice></div>
          )}
          <ul className="divide-y divide-border">
            {staffRows.map((p) => (
              <li key={p.user_id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3.5">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
                    <span className="truncate">{p.full_name || p.email}</span>
                    {p.is_me && <Badge tone="brand">{t.staffPage.you}</Badge>}
                    {!p.is_active && <Badge tone="danger">{t.staffPage.inactive}</Badge>}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-ink-faint" dir="ltr">{p.email}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <Badge tone={p.is_superuser ? 'warn' : 'neutral'}>{p.role_name}</Badge>
                    {p.employee_id !== null && (
                      <Badge tone="ok">{t.staffPage.onRoster}</Badge>
                    )}
                    <span className="text-xs text-ink-faint">
                      {t.staffPage.addedAt} {formatDate(p.created_at, locale)}
                    </span>
                  </div>

                  {/*
                    * Said here, where it can be fixed, rather than on the
                    * board where it cannot. Only for accounts that are not
                    * the owner's own — a superuser watching the team does not
                    * need a payroll row to do their job.
                    */}
                  {p.employee_id === null && !p.is_superuser && mayPayroll && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-field bg-warn-soft px-3 py-2 ring-1 ring-warn/20 ring-inset">
                      <span className="text-xs text-warn">{t.staffPage.notOnRosterHint}</span>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={enrolling === p.user_id}
                        onClick={() => void addToRoster(p)}
                      >
                        {enrolling === p.user_id
                          ? t.staffPage.addingToRoster
                          : t.staffPage.addToRoster}
                      </Button>
                    </div>
                  )}
                </div>
                {mayWrite && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                      {t.records.edit}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setPasswordFor(p)}>
                      {t.staffPage.password}
                    </Button>
                    {!p.is_me && (
                      <Button size="sm" variant="ghost" onClick={() => setRemoving(p)}>
                        {t.records.delete}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
            {staffRows.length === 0 && (
              <li className="px-5 py-10 text-center text-sm text-ink-faint">
                {people.loading ? t.common.loading : t.staffPage.emptyStaff}
              </li>
            )}
          </ul>
        </Card>

        <Card>
          <CardHeader
            title={t.staffPage.roles}
            hint={t.staffPage.subtitle}
            action={mayWrite
              ? (
                <Button size="sm" variant="secondary" onClick={() => setRoleModal(null)}>
                  {t.staffPage.addRole}
                </Button>
              )
              : undefined}
          />
          <ul className="divide-y divide-border">
            {roleRows.map((r) => (
              <li key={r.id} className="px-5 py-3.5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
                      <span className="truncate">{roleName(r)}</span>
                      {r.is_system && <Badge tone="neutral">{t.staffPage.builtIn}</Badge>}
                      {r.is_superuser && <Badge tone="warn">{t.staffPage.superuser}</Badge>}
                      {!r.is_active && <Badge tone="danger">{t.staffPage.inactive}</Badge>}
                    </p>
                    {r.description && (
                      <p className="mt-0.5 text-xs text-ink-muted">{r.description}</p>
                    )}
                    <p className="mt-1 text-xs text-ink-faint tnum">
                      {r.members} {t.staffPage.membersCount}
                      {' · '}
                      {r.is_superuser
                        ? t.staffPage.allPermissions
                        : `${(r.permissions ?? []).length} ${t.staffPage.permissionsCount}`}
                    </p>
                  </div>
                  {mayWrite && (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => setRoleModal(r)}>
                        {t.records.edit}
                      </Button>
                      {/* A built-in role and a role somebody holds are both
                          refused by the database. Not offering the button is
                          how that refusal stops being a surprise. */}
                      {!r.is_system && r.members === 0 && (
                        <Button size="sm" variant="ghost" onClick={() => setDeletingRole(r)}>
                          {t.records.delete}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </li>
            ))}
            {roleRows.length === 0 && (
              <li className="px-5 py-10 text-center text-sm text-ink-faint">
                {roles.loading ? t.common.loading : t.staffPage.emptyRoles}
              </li>
            )}
          </ul>
        </Card>
      </div>

      {roleError && (
        <div className="mt-4"><Notice tone="danger">{roleError}</Notice></div>
      )}

      <AddPersonModal
        open={adding}
        onClose={() => setAdding(false)}
        roles={roleRows}
        onSaved={reloadAll}
      />
      <EditPersonModal
        person={editing}
        roles={roleRows}
        onClose={() => setEditing(null)}
        onSaved={reloadAll}
      />
      <PasswordModal person={passwordFor} onClose={() => setPasswordFor(null)} />
      <RemovePersonDialog
        person={removing}
        onClose={() => setRemoving(null)}
        onDone={reloadAll}
      />
      <RoleModal
        role={roleModal}
        permissions={permissions.data ?? []}
        onClose={() => setRoleModal(undefined)}
        onSaved={reloadAll}
      />

      {deletingRole && (
        <Modal open onClose={() => setDeletingRole(null)} title={t.records.deleteTitle}>
          <div className="space-y-4">
            <p className="text-sm text-ink">
              {t.staffPage.roles}: <strong>{roleName(deletingRole)}</strong>
            </p>
            <Notice tone="info">{t.records.nothingAttached}</Notice>
            <div className={cx('flex justify-end gap-2 pt-1')}>
              <Button variant="ghost" onClick={() => setDeletingRole(null)}>
                {t.common.cancel}
              </Button>
              <Button variant="danger" onClick={() => deleteRole(deletingRole)}>
                {t.records.confirmDelete}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
