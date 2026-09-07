/**
 * HTTP helpers shared by the webhook endpoints.
 *
 * Kashier treats 200/201/202/204/409 as success and anything else — including
 * a timeout past 30s — as a failure worth retrying for ~23.5 hours. These
 * helpers keep that contract explicit at every return site.
 */

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // A webhook endpoint is not a browser resource.
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

/** 200 — the delivery was accepted. */
export function ok(body: Record<string, unknown> = { received: true }): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS });
}

/**
 * 409 — we already have this exact delivery.
 * Kashier documents 409 as success, so it stops retrying, and it reads as
 * "already handled" rather than pretending we did new work.
 */
export function duplicate(body: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ duplicate: true, ...body }), {
    status: 409,
    headers: JSON_HEADERS,
  });
}

/**
 * Failure responses stay deliberately terse. The caller is an unauthenticated
 * party until proven otherwise, so the body must not describe why
 * verification failed — the detail goes to webhook_rejections instead.
 */
export function failure(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), { status, headers: JSON_HEADERS });
}

export const methodNotAllowed = () => failure(405, 'method_not_allowed');
export const badRequest = (code = 'bad_request') => failure(400, code);
export const unauthorized = (code = 'unauthorized') => failure(401, code);
export const payloadTooLarge = () => failure(413, 'payload_too_large');

/** 1 MiB. A Kashier webhook body is a few KB; anything larger is not ours. */
export const MAX_BODY_BYTES = 1_048_576;

export async function readBoundedText(req: Request): Promise<string | null> {
  const declared = req.headers.get('content-length');
  if (declared && Number(declared) > MAX_BODY_BYTES) return null;

  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > MAX_BODY_BYTES) return null;
  return new TextDecoder().decode(buf);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Structured single-line logs so Supabase's log explorer can filter them. */
export function log(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown> = {},
) {
  console[level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'log'](
    JSON.stringify({ level, event, at: new Date().toISOString(), ...fields }),
  );
}
