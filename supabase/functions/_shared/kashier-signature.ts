/**
 * Kashier webhook signature verification.
 *
 * Kashier's reference implementation (Node.js) is:
 *
 *   data.signatureKeys.sort();
 *   const picked = _.pick(data, data.signatureKeys);
 *   const payload = queryString.stringify(picked);
 *   const sig = crypto.createHmac('sha256', apiKey).update(payload).digest('hex');
 *   sig === req.header('x-kashier-signature');
 *
 * The whole security of this endpoint rests on reproducing
 * `query-string@7.stringify` byte for byte, so its exact semantics are
 * re-implemented here rather than approximated:
 *
 *   - keys are sorted with the DEFAULT Array#sort, i.e. UTF-16 code-unit
 *     order, NOT locale order. 'Banana' < 'Zebra' < 'apple'.
 *   - values are encoded with strict RFC3986 encoding: encodeURIComponent
 *     plus !'()* escaped. Space becomes %20, never '+'.
 *   - `undefined` drops the pair entirely; `null` emits a bare key with no
 *     '='; an empty string emits 'key='.
 *   - keys absent from `data` are dropped by _.pick before stringify runs.
 *
 * Every one of those rules is pinned by golden vectors in
 * `supabase/tests/kashier-signature.test.ts`, generated from the real npm
 * packages. Do not "simplify" this file without re-running them.
 */

/** `strict-uri-encode` — the encoder query-string uses when strict: true. */
export function strictUriEncode(input: string): string {
  return encodeURIComponent(input).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeComponent(value: unknown): string {
  // encodeURIComponent coerces via String(), which is what query-string relies
  // on for numbers and booleans.
  return strictUriEncode(String(value));
}

/**
 * Faithful port of `queryString.stringify(obj)` with query-string's defaults
 * (encode: true, strict: true, arrayFormat: 'none', sort: default).
 */
export function stringifyLikeQueryString(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();

  return keys
    .map((key) => {
      const value = obj[key];

      if (value === undefined) return '';
      if (value === null) return encodeComponent(key);

      if (Array.isArray(value)) {
        // arrayFormat 'none': repeat the key for each element.
        return value
          .reduce<string[]>((acc, item) => {
            if (item === undefined) return acc;
            if (item === null) return [...acc, encodeComponent(key)];
            return [...acc, `${encodeComponent(key)}=${encodeComponent(item)}`];
          }, [])
          .join('&');
      }

      return `${encodeComponent(key)}=${encodeComponent(value)}`;
    })
    .filter((part) => part.length > 0)
    .join('&');
}

/**
 * Build the exact string Kashier signs, from a webhook payload's `data`.
 * Returns null when the payload carries no usable signatureKeys — callers must
 * treat that as "cannot verify", never as "verified".
 */
export function buildSignaturePayload(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;

  const record = data as Record<string, unknown>;
  const rawKeys = record.signatureKeys;
  if (!Array.isArray(rawKeys) || rawKeys.length === 0) return null;

  const keys = rawKeys.filter((k): k is string => typeof k === 'string').sort();
  if (keys.length === 0) return null;

  // Equivalent of underscore's _.pick: keep only keys actually present.
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      picked[key] = record[key];
    }
  }

  return stringifyLikeQueryString(picked);
}

const encoder = new TextEncoder();

/** HMAC-SHA256, lowercase hex — matches crypto.createHmac(...).digest('hex'). */
export async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Length-independent constant-time comparison.
 * A plain `===` on hex digests leaks a timing oracle that lets an attacker
 * recover a valid signature byte by byte.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const av = encoder.encode(a);
  const bv = encoder.encode(b);
  // Comparing lengths up front is safe: digest length is not a secret.
  if (av.length !== bv.length) return false;
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

export type VerifyResult = {
  valid: boolean;
  /** Which configured key matched, e.g. 'payment:live'. Null when none did. */
  matchedKeyId: string | null;
  /** The canonical string that was signed — useful when debugging a mismatch. */
  signaturePayload: string | null;
  reason: string | null;
};

export type CandidateKey = { id: string; secret: string };

/**
 * Verify `x-kashier-signature` against every candidate key.
 *
 * Trying more than one key is deliberate: it lets a single endpoint serve both
 * test and live webhooks and auto-detect which one a delivery came from. It
 * leaks nothing — each attempt is a full HMAC comparison that either matches
 * or does not.
 */
export async function verifyKashierSignature(
  data: unknown,
  headerSignature: string | null,
  candidates: CandidateKey[],
): Promise<VerifyResult> {
  const signaturePayload = buildSignaturePayload(data);

  if (!headerSignature) {
    return {
      valid: false,
      matchedKeyId: null,
      signaturePayload,
      reason: 'missing_signature_header',
    };
  }
  if (signaturePayload === null) {
    return {
      valid: false,
      matchedKeyId: null,
      signaturePayload: null,
      reason: 'no_signature_keys_in_payload',
    };
  }
  if (candidates.length === 0) {
    return { valid: false, matchedKeyId: null, signaturePayload, reason: 'no_api_keys_configured' };
  }

  const received = headerSignature.trim().toLowerCase();

  for (const candidate of candidates) {
    const expected = await hmacSha256Hex(signaturePayload, candidate.secret);
    if (timingSafeEqual(expected, received)) {
      return { valid: true, matchedKeyId: candidate.id, signaturePayload, reason: null };
    }
  }

  return { valid: false, matchedKeyId: null, signaturePayload, reason: 'signature_mismatch' };
}
