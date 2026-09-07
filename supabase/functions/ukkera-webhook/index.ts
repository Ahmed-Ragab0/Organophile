/**
 * ukkera webhook receiver.
 *
 * ukkera authenticates with a static bearer token rather than a signature:
 *
 *   POST /ukkera-webhook
 *   Authorization: Bearer <secret_token>
 *   { student_name, phone, course, amount, order_id, payment_date }
 *
 * A static token is weaker than an HMAC — it proves the sender knows a secret
 * but not that the body is untampered — so this endpoint treats ukkera data as
 * roster information only. Money is never derived from it; that always comes
 * from the signed Kashier feed. `subscriptions.amount` is what ukkera claims
 * was charged, and the dashboard reconciles it against `payments.amount`.
 *
 * Deployed with verify_jwt = false; the bearer check below is the auth.
 */
import {
  badRequest,
  duplicate,
  failure,
  log,
  MAX_BODY_BYTES,
  methodNotAllowed,
  ok,
  payloadTooLarge,
  readBoundedText,
  sha256Hex,
  unauthorized,
} from '../_shared/http.ts';
import { recordRejection, serviceClient } from '../_shared/db.ts';
import { optionalEnv } from '../_shared/env.ts';
import { timingSafeEqual } from '../_shared/kashier-signature.ts';
import { extractBearerToken } from '../_shared/webhook-parsing.ts';

const ENDPOINT = 'ukkera-webhook';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();

  const expected = optionalEnv('UKKERA_WEBHOOK_TOKEN');
  if (!expected) {
    // Fail closed. An unset token must never mean "let everyone in".
    log('error', 'ukkera_token_not_configured', {});
    return failure(500, 'not_configured');
  }

  const presented = extractBearerToken(req.headers.get('authorization'));
  if (!presented || !timingSafeEqual(presented, expected)) {
    await recordRejection({
      endpoint: ENDPOINT,
      reason: presented ? 'bad_bearer_token' : 'missing_bearer_token',
      detail: `from=${req.headers.get('x-forwarded-for') ?? 'unknown'}`,
    });
    log('warn', 'ukkera_auth_rejected', { hadToken: Boolean(presented) });
    return unauthorized();
  }

  const rawBody = await readBoundedText(req);
  if (rawBody === null) {
    log('warn', 'body_too_large', { limit: MAX_BODY_BYTES });
    return payloadTooLarge();
  }

  const bodyHash = await sha256Hex(rawBody);

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
    if (typeof payload !== 'object' || payload === null) throw new Error('not an object');
  } catch (_err) {
    await recordRejection({
      endpoint: ENDPOINT,
      reason: 'invalid_json',
      bodySha256: bodyHash,
      bodyExcerpt: rawBody.slice(0, 2000),
    });
    log('warn', 'invalid_json', { bodyHash });
    return badRequest('invalid_json');
  }

  try {
    const { data, error } = await serviceClient().rpc('ingest_ukkera_event', {
      p_payload: payload,
      p_body_sha256: bodyHash,
    });
    if (error) throw new Error(error.message);

    const result = data as { status?: string; raw_id?: string; processing?: string } | null;

    log('info', 'ukkera_delivery_ingested', {
      status: result?.status,
      processing: result?.processing,
      orderId: payload.order_id,
      bodyHash,
    });

    if (result?.status === 'duplicate') return duplicate({ raw_id: result.raw_id });
    return ok({ received: true, raw_id: result?.raw_id, processing: result?.processing });
  } catch (err) {
    log('error', 'ingest_failed', { message: String(err), bodyHash });
    return failure(500, 'ingest_failed');
  }
});
