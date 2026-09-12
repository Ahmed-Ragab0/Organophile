import type { Dict } from './i18n/dictionaries';

/**
 * What the database said, said again in a language the reader has.
 *
 * PostgREST hands back Postgres' own wording, and two of those messages reach
 * people regularly and mean nothing to them:
 *
 *   new row violates row-level security policy for table "projects"
 *   permission denied for schema app
 *
 * Both mean "you are not allowed to do that", and the first has a second,
 * nastier cause worth naming: a session that no longer matches the screen.
 * Signing out and back in as somebody else leaves the page rendered for the
 * previous account — the buttons are the old role's, the requests are the new
 * role's, and the database refuses them one at a time. Telling somebody to
 * reload is the difference between a five-second fix and an afternoon.
 *
 * Anything this does not recognise is passed through untouched. A message
 * nobody translated is far better than a generic "something went wrong" that
 * throws away the only clue.
 */
export type DbError = { message: string; code?: string } | null | undefined;

export function dbErrorText(error: DbError, t: Dict): string {
  if (!error) return t.common.error;
  const message = error.message ?? '';
  const code = error.code ?? '';

  // 42501 is insufficient_privilege — either RLS refusing the row, or one of
  // this system's own guards raising with that errcode.
  if (message.includes('row-level security')) return t.dbErrors.notAllowedOrStale;
  if (message.includes('permission denied for schema')) return t.dbErrors.notAllowed;
  if (code === '42501') return t.dbErrors.notAllowed;

  // 23505 unique_violation: almost always a name or a key typed twice.
  if (code === '23505' || message.includes('duplicate key value')) {
    return t.dbErrors.duplicate;
  }
  // 23503 foreign_key_violation: something it points at is gone or in use.
  if (code === '23503') return t.dbErrors.stillInUse;
  // 23514 check_violation: a value the schema will not accept.
  if (code === '23514') return t.dbErrors.badValue;

  return message === '' ? t.common.error : message;
}
