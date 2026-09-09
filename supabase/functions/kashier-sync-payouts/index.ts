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
import { badRequest, failure, log, methodNotAllowed, ok, unauthorized } from '../_shared/http.ts';
import { preflight, withCors } from '../_shared/cors.ts';
import { serviceClient } from '../_shared/db.ts';
import { type KashierMode, optionalEnv, requiredEnv } from '../_shared/env.ts';
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

/**
 * A failed GET used to return only its status code, and the transfers call has
 * been answering 400 for days with nobody able to see why. Kashier puts the
 * reason in the body; throwing it away turned a one-line fix into a guess.
 * The text is kept and trimmed, never the headers — the Secret Key is in those.
 */
async function kashierGet(
  mode: KashierMode,
  path: string,
  secret: string,
): Promise<{ status: number; body: unknown; detail: string | null }> {
  const res = await fetch(`${BASE_URL[mode]}${path}`, {
    method: 'GET',
    headers: { Authorization: secret, accept: 'application/json' },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return {
    status: res.status,
    body,
    detail: res.ok ? null : text.slice(0, 500) || null,
  };
}

Deno.serve(async (req) => {
  // The dashboard calls this from the browser with an Authorization header,
  // which makes it a preflighted request. Answer OPTIONS before anything else.
  const options = preflight(req);
  if (options) return options;

  return withCors(req, await handle(req));
});

/** Only the fields the account choice depends on; the rest travels as-is. */
type AccountRow = {
  isPrimary?: boolean;
  accountId?: string;
  merchantId?: string;
  type?: string;
  totalBalance?: number | string;
  availableBalance?: number | string;
  onHoldBalance?: number | string;
};

async function handle(req: Request): Promise<Response> {
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
  // `account: true, fetched: 0` was reported as a clean sync while the
  // transfers call was answering 400 every single time. A half that failed has
  // to reach the caller, or the screen congratulates the user on nothing.
  const summary = {
    mode, account: false, accountsReturned: 0,
    fetched: 0, ingested: 0, duplicates: 0, failed: 0,
    transfersOk: false,
    transfersError: null as { status: number; detail: string | null } | null,
    transfersTried: null as Array<
      { path: string; status: number; detail: string | null }
    > | null,
    accountError: null as { status: number; detail: string | null } | null,
  };

  // Filled in by the balance call below, because the transfer list may need
  // to be addressed by one of them and only Kashier knows which.
  let merchantId: string | null = null;
  let accountId: string | null = null;

  try {
    // --- balance -------------------------------------------------------------
    const account = await kashierGet(mode, '/v2/account', secret);
    if (account.status === 200) {
      const rows = (account.body as { data?: unknown[] })?.data ?? [];
      const list = Array.isArray(rows) ? (rows as AccountRow[]) : [];

      // Taking rows[0] was a guess. Kashier can return several accounts for
      // one merchant — the stored one came back with isPrimary false and a
      // zero balance while real money had been collected, which is exactly
      // what reading the wrong row looks like. Prefer the primary, then any
      // account actually holding a balance, and only then fall back to first.
      const chosen =
        list.find((a) => a?.isPrimary === true)
        ?? list.find((a) => Number(a?.totalBalance ?? 0) !== 0
                         || Number(a?.availableBalance ?? 0) !== 0
                         || Number(a?.onHoldBalance ?? 0) !== 0)
        ?? list[0]
        ?? null;

      if (chosen) {
        const { error } = await client.rpc('upsert_kashier_account', {
          p_mode: mode,
          // The whole list travels with it. When a balance looks wrong, the
          // first question is "which account is this", and that is only
          // answerable if the alternatives were kept.
          p_payload: { ...chosen, _accountsReturned: list.length, _allAccounts: list },
        });
        if (error) throw new Error(`account upsert: ${error.message}`);
        summary.account = true;
        summary.accountsReturned = list.length;
        merchantId = typeof chosen.merchantId === 'string' ? chosen.merchantId : null;
        accountId = typeof chosen.accountId === 'string' ? chosen.accountId : null;
      }

      log('info', 'account_selected', {
        mode,
        returned: list.length,
        isPrimary: chosen?.isPrimary ?? null,
        accountId: chosen?.accountId ?? null,
        type: chosen?.type ?? null,
      });
    } else {
      summary.accountError = { status: account.status, detail: account.detail };
      log('warn', 'account_fetch_failed', {
        mode, status: account.status, detail: account.detail,
      });
    }

    /*
     * --- transfers ----------------------------------------------------------
     *
     * `/v2/transfers?sortType=desc&…` has been answering 400 on every run, and
     * the balance call beside it — same host, same Secret Key — answers 200.
     * So the key is right and the request is not, and Kashier's documentation
     * is not something this account's behaviour has matched before.
     *
     * Rather than change one guess per deploy, the shapes are tried in order on
     * the first page only, and the one that answers is remembered for the rest
     * of the run. Every attempt is a read-only GET, and each is logged with
     * what Kashier said, so a run that still fails ends with a list of what was
     * tried instead of a bare status code.
     */
    const transferPaths = (page: number): string[] => {
      const q = `limit=${PAGE_LIMIT}&page=${page}`;
      return [
        // Known good, 9 Sep 2026. `sortType=desc` is what the 400 was about —
        // Kashier rejects the parameter outright rather than ignoring it, and
        // it stays in the list below only so a future change is caught.
        `/v2/transfers?${q}`,
        `/v2/transfers?sortType=desc&${q}`,
        merchantId ? `/v2/transfers/${merchantId}?${q}` : null,
        merchantId ? `/v2/transfers?merchantId=${merchantId}&${q}` : null,
        accountId ? `/v2/transfers?accountId=${accountId}&${q}` : null,
        `/v2/payouts?${q}`,
      ].filter((v): v is string => v !== null);
    };

    // Once a shape works, stop probing: the fallback exists to find the right
    // request, not to make five of them on every page.
    let workingPath: ((page: number) => string) | null = null;

    for (let page = 1; page <= maxPages; page++) {
      let res: Awaited<ReturnType<typeof kashierGet>> | null = null;

      if (workingPath) {
        res = await kashierGet(mode, workingPath(page), secret);
      } else {
        const attempts: Array<{ path: string; status: number; detail: string | null }> = [];
        for (const path of transferPaths(page)) {
          const attempt = await kashierGet(mode, path, secret);
          attempts.push({ path, status: attempt.status, detail: attempt.detail });
          if (attempt.status === 200) {
            res = attempt;
            const template = path.replace(`page=${page}`, 'page=');
            workingPath = (p: number) => `${template}${p}`;
            log('info', 'transfers_path_found', { mode, path });
            break;
          }
        }
        if (!res) {
          const first = attempts[0];
          summary.transfersError = { status: first.status, detail: first.detail };
          summary.transfersTried = attempts;
          log('warn', 'transfers_fetch_failed', { mode, page, attempts });
          break;
        }
      }

      if (res.status !== 200) {
        summary.transfersError = { status: res.status, detail: res.detail };
        log('warn', 'transfers_fetch_failed', {
          mode, page, status: res.status, detail: res.detail,
        });
        break;
      }
      summary.transfersOk = true;

      // Kashier's account endpoint returned a bare array where a wrapper was
      // assumed, and that cost us every balance reading until it was found.
      // Do not assume a single shape here either: a transfer of 95.67 exists
      // at Kashier with a reference and a date, and this loop has never once
      // produced a payout row — reading only `data.transfers` is the likeliest
      // reason. Accept every shape it could plausibly take.
      const body = res.body as {
        data?: { transfers?: TransferRow[] } | TransferRow[];
        transfers?: TransferRow[];
      } | null;
      const data = body?.data;
      const transfers: TransferRow[] =
        Array.isArray(data) ? data
          : Array.isArray((data as { transfers?: TransferRow[] })?.transfers)
            ? (data as { transfers: TransferRow[] }).transfers
            : Array.isArray(body?.transfers) ? body.transfers
              : [];

      if (transfers.length === 0) {
        /*
         * An empty list is not automatically the truth. Kashier's account
         * endpoint reports a transfer of 100.57 dated 9 Sep 2026 while this
         * list comes back with nothing in it, and the response carries an
         * `inProgressTransfersCount` and a `pagination` block that would say
         * which of those two is right.
         *
         * The whole body is logged HERE and only here, where `transfers` is
         * empty by definition — so it cannot contain anyone's bank details.
         */
        log('info', 'transfers_page_empty', {
          mode,
          page,
          bodyKeys: body ? Object.keys(body) : [],
          dataKeys: data && !Array.isArray(data) ? Object.keys(data) : null,
          dataIsArray: Array.isArray(data),
          body: JSON.stringify(res.body).slice(0, 1000),
        });

        // The list may simply be scoped to something we have not named. Probe
        // the ways it could be, once, on the first page only.
        if (page === 1) {
          const scoped = [
            accountId ? `/v2/transfers?limit=${PAGE_LIMIT}&page=1&accountId=${accountId}` : null,
            merchantId ? `/v2/transfers?limit=${PAGE_LIMIT}&page=1&merchantId=${merchantId}` : null,
            `/v2/transfers?limit=${PAGE_LIMIT}&page=1&status=TRANSFERRED`,
            `/v2/transfers?limit=${PAGE_LIMIT}&page=1&sortType=DESC`,
          ].filter((v): v is string => v !== null);

          for (const path of scoped) {
            const probe = await kashierGet(mode, path, secret);
            log('info', 'transfers_scope_probe', {
              mode,
              path,
              status: probe.status,
              body: JSON.stringify(probe.body).slice(0, 600),
            });
          }
        }
        break;
      }

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
}
