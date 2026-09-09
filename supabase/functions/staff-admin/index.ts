/**
 * Creating a login is the one thing the dashboard cannot do by itself.
 *
 * Everything else in this app is a table the browser writes through RLS. An
 * account is not: `auth.admin.createUser` needs the service role key, and that
 * key must never be in `web/` — a build artefact that reaches a browser is a
 * key that reaches a browser. So it lives here, in a function that:
 *
 *   1. Re-checks the caller with the caller's OWN token, through `my_access`,
 *      so the permission is decided by the database and not by this file.
 *   2. Does the one privileged step.
 *   3. Writes the `staff` row AS THE CALLER, not as the service role — which
 *      is what keeps the last-admin and no-editing-yourself rules in force.
 *      Bypassing RLS for the convenient half and honouring it for the rest is
 *      how a guard becomes decorative.
 *
 * Removing a person is the same shape in reverse: the `staff` delete happens
 * first, as the caller, so a refusal from the trigger stops the account from
 * being deleted at all.
 */
import {
  badRequest,
  extractBearerToken,
  failure,
  log,
  methodNotAllowed,
  ok,
} from '../_shared/http.ts';
import { preflight, withCors } from '../_shared/cors.ts';
import { requiredEnv } from '../_shared/env.ts';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

/** Supabase's own floor is 6; this is the number the UI promises. */
const MIN_PASSWORD = 8;

type Action = 'create' | 'set_password' | 'remove';

type Body = {
  action?: string;
  email?: string;
  password?: string;
  full_name?: string | null;
  phone?: string | null;
  note?: string | null;
  role_id?: string;
  user_id?: string;
};

/** The caller, acting as themselves. Every RLS rule still applies to this one. */
function clientForCaller(token: string): SupabaseClient {
  return createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** The service role. Used for exactly two calls: create and delete an account. */
function adminClient(): SupabaseClient {
  return createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type Caller = { userId: string; asCaller: SupabaseClient };

/**
 * Who is asking, and may they. The answer comes from `my_access` rather than
 * from a table read here, so this function and the database can never disagree
 * about what `staff.write` means.
 */
async function authorize(req: Request): Promise<Caller | Response> {
  const token = extractBearerToken(req.headers.get('authorization'));
  if (!token) return failure(401, 'unauthorized');

  const asCaller = clientForCaller(token);
  const { data: { user }, error } = await asCaller.auth.getUser();
  if (error || !user) return failure(401, 'unauthorized');

  const { data } = await asCaller.rpc('my_access');
  const access = (data ?? null) as { permissions?: string[] } | null;
  if (!access?.permissions?.includes('staff.write')) return failure(403, 'forbidden');

  return { userId: user.id, asCaller };
}

/**
 * Supabase reports both of these as plain messages. Matching on the text is
 * unpleasant but the alternative is showing a raw English sentence to an
 * Arabic-speaking owner, and these two are the only failures a person actually
 * causes.
 */
function mapAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('already been registered') || m.includes('already exists')) return 'email_taken';
  if (m.includes('password')) return 'weak_password';
  return 'unknown';
}

/** A trigger's refusal, translated into something the UI has a sentence for. */
function mapDbError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('last administrator')) return 'last_admin';
  if (m.includes('your own')) return 'self_change';
  if (m.includes('row-level security') || m.includes('permission denied')) return 'forbidden';
  return 'unknown';
}

async function create(caller: Caller, body: Body): Promise<Response> {
  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';
  const roleId = (body.role_id ?? '').trim();

  if (!email.includes('@') || email.length < 5) return badRequest('invalid_email');
  if (password.length < MIN_PASSWORD) return failure(400, 'weak_password');
  if (roleId === '') return badRequest('role_required');

  const admin = adminClient();
  const { data: created, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    // Confirmed on creation: the owner is handing the password over in person,
    // and a confirmation email to an address they typed is a step that only
    // fails silently.
    email_confirm: true,
  });

  if (authError || !created?.user) {
    log('warn', 'staff_create_auth_failed', { reason: authError?.message ?? 'no_user' });
    return failure(400, mapAuthError(authError?.message ?? ''));
  }

  const { error: rowError } = await caller.asCaller.from('staff').insert({
    user_id: created.user.id,
    email,
    full_name: body.full_name ?? null,
    phone: body.phone ?? null,
    note: body.note ?? null,
    role_id: roleId,
    created_by: caller.userId,
  });

  if (rowError) {
    // An auth account with no staff row is a login that reaches the denied
    // screen and nothing else — invisible in the app and impossible to clean
    // up from it. Undo the half that succeeded.
    await admin.auth.admin.deleteUser(created.user.id);
    log('warn', 'staff_create_row_failed', { reason: rowError.message });
    return failure(400, mapDbError(rowError.message));
  }

  log('info', 'staff_created', { by: caller.userId });
  return ok({ ok: true, user_id: created.user.id });
}

async function setPassword(caller: Caller, body: Body): Promise<Response> {
  const userId = (body.user_id ?? '').trim();
  const password = body.password ?? '';
  if (userId === '') return badRequest('user_required');
  if (password.length < MIN_PASSWORD) return failure(400, 'weak_password');

  // Read through the caller's own client: RLS decides whether this person is
  // even visible to them, so a user id guessed from elsewhere gets nowhere.
  const { data: row } = await caller.asCaller
    .from('staff').select('user_id').eq('user_id', userId).maybeSingle();
  if (!row) return failure(404, 'not_found');

  const { error } = await adminClient().auth.admin.updateUserById(userId, { password });
  if (error) {
    log('warn', 'staff_password_failed', { reason: error.message });
    return failure(400, mapAuthError(error.message));
  }

  log('info', 'staff_password_set', { by: caller.userId });
  return ok({ ok: true });
}

async function remove(caller: Caller, body: Body): Promise<Response> {
  const userId = (body.user_id ?? '').trim();
  if (userId === '') return badRequest('user_required');

  // The staff row goes first, as the caller. If the trigger refuses — the last
  // administrator, or your own account — the account itself is untouched.
  const { error, count } = await caller.asCaller
    .from('staff').delete({ count: 'exact' }).eq('user_id', userId);

  if (error) {
    log('warn', 'staff_remove_refused', { reason: error.message });
    return failure(400, mapDbError(error.message));
  }
  if (count === 0) return failure(404, 'not_found');

  const { error: authError } = await adminClient().auth.admin.deleteUser(userId);
  if (authError) {
    // The row is gone, so they cannot get in; the orphaned account is untidy
    // rather than dangerous. Reported rather than retried.
    log('error', 'staff_remove_auth_failed', { reason: authError.message });
    return ok({ ok: true, auth_deleted: false });
  }

  log('info', 'staff_removed', { by: caller.userId });
  return ok({ ok: true, auth_deleted: true });
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed();

  const caller = await authorize(req);
  if (caller instanceof Response) return caller;

  let body: Body;
  try {
    body = await req.json() as Body;
  } catch {
    return badRequest('invalid_json');
  }

  switch (body.action as Action) {
    case 'create':
      return await create(caller, body);
    case 'set_password':
      return await setPassword(caller, body);
    case 'remove':
      return await remove(caller, body);
    default:
      return badRequest('unknown_action');
  }
}

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;
  return withCors(req, await handle(req));
});
