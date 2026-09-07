/**
 * Kashier webhook receiver.
 *
 * Contract with Kashier:
 *   - Acknowledge with 200/201/202/204/409 within 30 seconds. Anything else
 *     triggers ~23.5 hours of retries.
 *   - Deliveries are at-least-once and unordered.
 *
 * Shape of this handler: verify, land the raw body, acknowledge. All domain
 * work happens inside `ingest_kashier_event`, which is written never to throw,
 * so a projection bug can never turn into a retry storm.
 *
 * Deployed with verify_jwt = false: Kashier cannot present a Supabase JWT.
 * Authentication is the HMAC signature check below, which is strictly stronger
 * for this purpose because it also proves payload integrity.
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
import { boolEnv, candidateKeys, type KashierMode } from '../_shared/env.ts';
import { verifyKashierSignature } from '../_shared/kashier-signature.ts';
import {
  classifyPayload,
  isCombinedEnvelope,
  parseMode,
  signedDataFor,
} from '../_shared/webhook-parsing.ts';

const ENDPOINT = 'kashier-webhook';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return methodNotAllowed();

  const url = new URL(req.url);
  // Pinning ?mode= is optional but recommended: it removes any ambiguity about
  // which key a delivery should verify against.
  const pinnedMode = parseMode(url.searchParams.get('mode'));
  const source = url.searchParams.get('source') === 'server' ? 'server' : 'configured';

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

  // The dashboard Test button sends a combined envelope when one webhook
  // subscribes to both resource types. Production setups should register a
  // transaction webhook and a transfer webhook separately, which avoids it.
  const isCombined = isCombinedEnvelope(payload);

  const event = isCombined ? null : payload.event;
  const resource = isCombined ? 'unknown' : classifyPayload(payload);
  const signedData = isCombined
    ? (payload.transfer as Record<string, unknown>) ?? payload
    : signedDataFor(payload);

  const keys = candidateKeys(resource, pinnedMode);
  const verdict = await verifyKashierSignature(
    signedData,
    req.headers.get('x-kashier-signature'),
    keys,
  );

  const allowUnverified = boolEnv('KASHIER_ALLOW_UNVERIFIED', false);

  if (!verdict.valid) {
    // Always audit — the excerpt is how you inspect a delivery you refused,
    // without ever having trusted it.
    await recordRejection({
      endpoint: ENDPOINT,
      reason: verdict.reason ?? 'signature_invalid',
      detail: `resource=${resource} event=${String(event)} keysTried=${keys.length} pinnedMode=${
        pinnedMode ?? 'none'
      }`,
      bodySha256: bodyHash,
      bodyExcerpt: rawBody.slice(0, 2000),
    });
    log('warn', 'signature_rejected', {
      reason: verdict.reason,
      resource,
      event,
      keysTried: keys.length,
      bodyHash,
    });

    if (!allowUnverified) {
      // 401 is deliberate: Kashier will retry, which buys time to fix a key
      // without losing the delivery.
      return unauthorized('signature_invalid');
    }
    log('error', 'ingesting_unverified_delivery', {
      warning: 'KASHIER_ALLOW_UNVERIFIED is on — never leave this enabled in live mode',
      bodyHash,
    });
  }

  // Resolve the mode from the key that actually verified, rather than parsing
  // its label. A delivery we could not verify never reaches here unless
  // KASHIER_ALLOW_UNVERIFIED is on, in which case 'live' is the safe default.
  const matchedKey = keys.find((k) => k.id === verdict.matchedKeyId) ?? null;
  const mode: KashierMode = pinnedMode ?? matchedKey?.mode ?? 'live';

  try {
    const client = serviceClient();

    if (isCombined) {
      // Ingest each half under its own resource type.
      const parts: Array<[string, unknown]> = [
        ['transaction', payload.transaction],
        ['transfer', payload.transfer],
      ];
      for (const [kind, part] of parts) {
        if (!part || typeof part !== 'object') continue;
        const { error } = await client.rpc('ingest_kashier_event', {
          p_payload: part,
          p_body_sha256: await sha256Hex(`${bodyHash}:${kind}`),
          p_signature_valid: verdict.valid,
          p_mode: mode,
          p_resource_type: kind,
          p_source: source,
          p_signature_note: verdict.matchedKeyId,
        });
        if (error) throw new Error(error.message);
      }
      log('info', 'combined_test_envelope_ingested', { mode, bodyHash });
      return ok({ received: true, combined: true });
    }

    const { data, error } = await client.rpc('ingest_kashier_event', {
      p_payload: payload,
      p_body_sha256: bodyHash,
      p_signature_valid: verdict.valid,
      p_mode: mode,
      p_resource_type: resource === 'unknown' ? 'unknown' : resource,
      p_source: source,
      p_signature_note: verdict.matchedKeyId,
    });
    if (error) throw new Error(error.message);

    const result = data as { status?: string; raw_id?: string; processing?: string } | null;

    log('info', 'delivery_ingested', {
      status: result?.status,
      processing: result?.processing,
      event,
      resource,
      mode,
      key: verdict.matchedKeyId,
      bodyHash,
    });

    if (result?.status === 'duplicate') return duplicate({ raw_id: result.raw_id });
    return ok({ received: true, raw_id: result?.raw_id, processing: result?.processing });
  } catch (err) {
    // The signature was valid but we could not store the delivery. This is the
    // one case where a retry genuinely helps, so ask for one.
    log('error', 'ingest_failed', { message: String(err), bodyHash });
    return failure(500, 'ingest_failed');
  }
});
