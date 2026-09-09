/**
 * Which permission each page needs.
 *
 * Imported by the middleware (edge runtime) as well as by the sidebar, so it
 * must stay free of React and of anything Node-only. One list, two consumers:
 * a nav that hides a link the middleware would then refuse is the same bug as
 * a nav that shows one it would refuse, and both come from keeping two lists.
 *
 * Matching is longest-prefix, so `/pricing/abc` inherits `/pricing`.
 */
export const ROUTE_PERMISSIONS: Record<string, string> = {
  '/': 'overview.read',
  '/students': 'students.read',
  '/courses': 'courses.read',
  '/classification': 'courses.read',
  '/subscriptions': 'subscriptions.read',
  '/pricing': 'subscriptions.read',
  '/wallets': 'money.read',
  '/ledger': 'money.read',
  '/expenses': 'money.read',
  '/payments': 'payments.read',
  '/payouts': 'payments.read',
  '/reconciliation': 'payments.read',
  '/journey': 'payments.read',
  '/reports': 'reports.read',
  '/settings': 'settings.read',
  '/staff': 'staff.read',
  // Import writes students in bulk and is the one screen that can rewrite the
  // roster wholesale, so it asks for more than the page it sits next to.
  '/import': 'system.write',
  '/health': 'system.read',
};

/** The permission `path` needs, or null when the path is not gated. */
export function permissionForPath(path: string): string | null {
  if (path === '/') return ROUTE_PERMISSIONS['/'];

  let best: string | null = null;
  for (const prefix of Object.keys(ROUTE_PERMISSIONS)) {
    if (prefix === '/') continue;
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      if (best === null || prefix.length > best.length) best = prefix;
    }
  }
  return best === null ? null : ROUTE_PERMISSIONS[best];
}

/**
 * Where to send someone who has an account but cannot open the page they
 * asked for.
 *
 * The first page they *can* open, in the order the sidebar lists them, so the
 * answer to "you cannot see this" is a screen rather than a dead end. Null only
 * when they hold nothing at all, which is a staff row with an empty role.
 */
export function firstAllowedPath(permissions: readonly string[]): string | null {
  const held = new Set(permissions);
  const order = [
    '/', '/students', '/subscriptions', '/pricing', '/courses', '/classification',
    '/reports', '/wallets', '/ledger', '/expenses',
    '/payments', '/payouts', '/journey', '/reconciliation',
    '/settings', '/staff', '/health',
  ];
  for (const path of order) {
    const need = ROUTE_PERMISSIONS[path];
    if (need && held.has(need)) return path;
  }
  return null;
}
