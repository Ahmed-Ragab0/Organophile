/**
 * CORS for the one endpoint a browser actually calls.
 *
 * The bug this fixes: the payouts page's "sync from Kashier" button failed with
 * `TypeError: Failed to fetch` and nothing in the function logs. The request
 * carries an `Authorization` header, which is not CORS-safelisted, so the
 * browser sends an OPTIONS preflight first. `kashier-sync-payouts` answered
 * that with 405 and no `Access-Control-Allow-*` headers, so the browser
 * discarded the whole exchange before the POST was ever sent — the fetch never
 * reached the network, which is why the error had no status code.
 *
 * The webhook endpoints deliberately do NOT use this. They are server-to-server
 * and no browser should be able to reach them; a permissive preflight there
 * would only widen the surface.
 *
 * Origins are reflected from an allowlist, never `*`. The request carries a
 * bearer token, so a wildcard would let any page on the internet spend an
 * admin's session on a sync.
 */
import { optionalEnv } from './env.ts';

/** Local development. Production origins come from DASHBOARD_ORIGINS. */
const DEFAULT_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

function allowedOrigins(): string[] {
  const configured = (optionalEnv('DASHBOARD_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter((s) => s.length > 0);
  return [...DEFAULT_ORIGINS, ...configured];
}

/**
 * The headers to add for this request's Origin, or an empty object when the
 * caller is not a browser we know. `Vary: Origin` is always sent so a CDN
 * cannot serve one origin's allow header to another.
 */
export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin');
  if (!origin) return {}; // curl, cron, server-to-server — CORS does not apply.

  const base = { vary: 'Origin' };
  if (!allowedOrigins().includes(origin.replace(/\/$/, ''))) return base;

  return {
    ...base,
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, apikey, x-client-info',
    'access-control-max-age': '86400',
  };
}

/** 204 for the preflight. Returns null when this is not a preflight. */
export function preflight(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

/** Copies a response, adding this request's CORS headers. */
export function withCors(req: Request, res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(req))) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
