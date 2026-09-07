import { assert, assertEquals } from 'jsr:@std/assert@1';
import { corsHeaders, preflight, withCors } from '../functions/_shared/cors.ts';

/**
 * These pin the two failure modes that matter for the payout sync endpoint.
 *
 * Too strict and the dashboard's sync button dies with `TypeError: Failed to
 * fetch` and no status code — the regression this file exists to prevent.
 * Too loose and any page on the internet can spend a signed-in admin's session
 * on a sync, because the request carries a bearer token.
 */

const req = (init: { method?: string; origin?: string | null } = {}) =>
  new Request('https://example.supabase.co/functions/v1/kashier-sync-payouts?mode=live', {
    method: init.method ?? 'POST',
    headers: init.origin === undefined || init.origin === null ? {} : { origin: init.origin },
  });

Deno.test('an allowlisted dev origin gets a usable preflight', () => {
  const res = preflight(req({ method: 'OPTIONS', origin: 'http://localhost:3000' }));
  assert(res, 'OPTIONS must be answered, not fall through to 405');
  assertEquals(res.status, 204);
  assertEquals(res.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  // The dashboard sends Authorization, which is what forces the preflight in
  // the first place; omitting it from allow-headers fails the exchange.
  assert(res.headers.get('access-control-allow-headers')?.includes('authorization'));
  assert(res.headers.get('access-control-allow-methods')?.includes('POST'));
});

Deno.test('an unknown origin is answered but never allowed', () => {
  const res = preflight(req({ method: 'OPTIONS', origin: 'https://evil.example' }));
  assert(res);
  assertEquals(res.status, 204);
  assertEquals(res.headers.get('access-control-allow-origin'), null);
  // Vary is still set, so a cache cannot hand one origin another's allow header.
  assertEquals(res.headers.get('vary'), 'Origin');
});

Deno.test('the wildcard is never used, for any origin', () => {
  for (const origin of ['http://localhost:3000', 'https://evil.example', 'null']) {
    assertEquals(
      corsHeaders(req({ origin }))['access-control-allow-origin'] ?? null,
      origin === 'http://localhost:3000' ? origin : null,
    );
  }
});

Deno.test('a trailing slash on the origin still matches', () => {
  const headers = corsHeaders(req({ origin: 'http://localhost:3000/' }));
  assertEquals(headers['access-control-allow-origin'], 'http://localhost:3000/');
});

Deno.test('a non-browser caller gets no CORS headers at all', () => {
  // cron and curl send no Origin; CORS does not apply and must not be invented.
  assertEquals(corsHeaders(req({ origin: null })), {});
  assertEquals(preflight(req({ method: 'POST', origin: null })), null);
});

Deno.test('withCors preserves the response it wraps', async () => {
  const wrapped = withCors(
    req({ origin: 'http://localhost:3000' }),
    new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
  );

  // A refusal is still a refusal — CORS headers must not change the outcome,
  // only let the browser read it.
  assertEquals(wrapped.status, 401);
  assertEquals(wrapped.headers.get('content-type'), 'application/json; charset=utf-8');
  assertEquals(wrapped.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assertEquals(await wrapped.json(), { error: 'unauthorized' });
});

Deno.test('DASHBOARD_ORIGINS adds production origins', () => {
  Deno.env.set('DASHBOARD_ORIGINS', 'https://money.organophile.app, https://staging.example/');
  try {
    assertEquals(
      corsHeaders(req({ origin: 'https://money.organophile.app' }))['access-control-allow-origin'],
      'https://money.organophile.app',
    );
    assertEquals(
      corsHeaders(req({ origin: 'https://staging.example' }))['access-control-allow-origin'],
      'https://staging.example',
    );
    assertEquals(
      corsHeaders(req({ origin: 'https://other.example' }))['access-control-allow-origin'],
      undefined,
    );
  } finally {
    Deno.env.delete('DASHBOARD_ORIGINS');
  }
});
