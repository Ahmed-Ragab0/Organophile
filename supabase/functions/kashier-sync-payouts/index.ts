/**
 * Pulls payouts from Kashier's Payout API instead of waiting for webhooks.
 *
 * Why this exists: this merchant's transfer webhooks arrive with no
 * `x-kashier-signature` header at all, so they cannot be trusted and are
 * refused. A GET we make ourselves, authenticated with our own Secret Key over
 * TLS, is trustworthy by construction — strictly better provenance than an
 * unsigned inbound POST. Payout tracking therefore does not depend on Kashier
 * enabling transfer signing.
 *
 *   GET /v2/account            -> merchant balance and payout method
 *   GET /v2/transfers?page=&limit= -> the transfer list
 *
 * Rows land through the same projection the webhook uses, so a webhook and a
 * sync for the same transfer converge on one row and the state can only move
 * forward.
 *
 * Deployed with verify_jwt = false because Supabase's JWT check would also
 * accept the public anon key. Authorisation is done properly below: either the
 * service role key (for cron) or a signed-in admin.
 */
import {
  badRequest,
  failure,
  log,
  methodNotAllowed,
  ok,
  unauthorized,
} from '../_shared/http.ts';
import { serviceClient } from '../_shared/db.ts';
import { optionalEnv, requiredEnv, type KashierMode } from '../_shared/env.ts';
import { timingSafeEqual } from '../_shared/kashier-signature.ts';
import { extractBearerToken, parseMode } from '../_shared/webhook-parsing.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const BASE_URL: Record<KashierMode, string> = {
  live: 'https://api.kashier.io',
  test: 'https://test-api.kashier.io',
};

const PAGE_LIMIT = 100;
const MAX_PAGES = 20; // 2000 transfers per run is far beyond any real backlog.

/** Kashier's transfer list rows, as documented. Only what we project is typed. */
type TransferRow = Record<string, unknown>;

function secretKeyFor(mode: KashierMode): string | null {
  return optionalEnv(mode === 'live' ? 'KASHIER_SECRET_KEY_LIVE' : 'KASHIER_SECRET_KEY_TEST');
}

/**
 * Either the service role key (cron) or a signed-in admin may run a sync.
 * Anything else is refused before a single upstream request is made.
 */
async function authorise(req: Request): Promise<{ ok: true } | { ok: false; reason: string }> {
  const token = extractBearerToken(req.headers.get('authorization'));
  if (!token) return { ok: false, reason: 'missing_token' };

  const serviceKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (timingSafeEqual(token, serviceKey)) return { ok: true };

  // Not the service key, so it must be a user JWT belonging to an admin.
  const asUser = createClient(
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_ANON_KEY'),
    { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } },
  );

  const { data: { user }, error } = await asUser.auth.getUser();
  if (error || !user) return { ok: false, reason: 'invalid_token' };

  // RLS already limits admin_users to admins, so a row coming back IS the check.
  const { data: admin } = await asUser
    .from('admin_users').select('user_id').eq('user_id', user.id).maybeSingle();

  return admin ? { ok: true } : { ok: false, reason: 'not_admin' };
}

async function kashierGet(
  mode: KashierMode,
  path: string,
  secret: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL[mode]}${path}`, {
    method: 'GET',
    headers: { Authorization: secret, accept: 'application/json' },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();

  const auth = await authorise(req);
  if (!auth.ok) {
    log('warn', 'sync_unauthorised', { reason: auth.reason });
    return unauthorized();
  }

  const url = new URL(req.url);
  const mode = parseMode(url.searchParams.get('mode')) ?? 'live';
  const maxPages = Math.min(Number(url.searchParams.get('pages') ?? '5') || 5, MAX_PAGES);

  const secret = secretKeyFor(mode);
  if (!secret) {
    log('error', 'sync_no_secret_key', { mode });
    return badRequest('no_secret_key_for_mode');
  }

  const client = serviceClient();
  const summary = { mode, account: false, fetched: 0, ingested: 0, duplicates: 0, failed: 0 };

  try {
    // --- balance -------------------------------------------------------------
    const account = await kashierGet(mode, '/v2/account', secret);
    if (account.status === 200) {
      const rows = (account.body as { data?: unknown[] })?.data ?? [];
      const first = Array.isArray(rows) ? rows[0] : null;
      if (first) {
        const { error } = await client.rpc('upsert_kashier_account', {
          p_mode: mode,
          p_payload: first,
        });
        if (error) throw new Error(`account upsert: ${error.message}`);
        summary.account = true;
      }
    } else {
      log('warn', 'account_fetch_failed', { mode, status: account.status });
    }

    // --- transfers -----------------------------------------------------------
    for (let page = 1; page <= maxPages; page++) {
      const res = await kashierGet(
        mode,
        `/v2/transfers?sortType=desc&limit=${PAGE_LIMIT}&page=${page}`,
        secret,
      );

      if (res.status !== 200) {
        log('warn', 'transfers_fetch_failed', { mode, page, status: res.status });
        break;
      }

      const data = (res.body as { data?: { transfers?: TransferRow[] } })?.data;
      const transfers = data?.transfers ?? [];
      if (transfers.length === 0) break;

      for (const transfer of transfers) {
        summary.fetched++;

        // Hash the transfer's own identity + state so re-syncing an unchanged
        // transfer dedupes, while a genuine state change is a new raw row.
        const id = String(transfer.id ?? transfer.transferId ?? '');
        const state = String(transfer.status ?? '');
        const digest = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(`api_sync:${mode}:${id}:${state}:${transfer.amount ?? ''}`),
        );
        const bodyHash = Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');

        const { data: result, error } = await client.rpc('ingest_kashier_event', {
          p_payload: transfer,
          p_body_sha256: bodyHash,
          // Authenticated by our own Secret Key over TLS, not by an inbound
          // signature — recorded as such rather than pretending it was signed.
          p_signature_valid: true,
          p_mode: mode,
          p_resource_type: 'transfer',
          p_source: 'api_sync',
          p_signature_note: `api_sync:${mode}`,
        });

        if (error) {
          summary.failed++;
          log('error', 'transfer_ingest_failed', { id, message: error.message });
          continue;
        }

        const r = result as { status?: string; processing?: string } | null;
        if (r?.status === 'duplicate') summary.duplicates++;
        else if (r?.processing === 'processed') summary.ingested++;
        else summary.failed++;
      }

      if (transfers.length < PAGE_LIMIT) break;
    }

    log('info', 'payout_sync_complete', summary);
    return ok(summary as unknown as Record<string, unknown>);
  } catch (err) {
    log('error', 'payout_sync_failed', { message: String(err), summary });
    return failure(500, 'sync_failed');
  }
});
