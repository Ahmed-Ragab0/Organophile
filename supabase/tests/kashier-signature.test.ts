/**
 * Golden-vector tests for the Kashier signature implementation.
 *
 * The vectors in `kashier-signature-vectors.json` were produced by
 * `generate-vectors.js` running Kashier's own documented Node.js algorithm
 * against the real npm packages (query-string@7.1.3, underscore@1.13.6).
 * They are the ground truth: if this suite passes, our Deno implementation
 * produces the same bytes Kashier's server does.
 *
 * Regenerate with:  node supabase/tests/generate-vectors.js > supabase/tests/kashier-signature-vectors.json
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  buildSignaturePayload,
  hmacSha256Hex,
  strictUriEncode,
  timingSafeEqual,
  verifyKashierSignature,
} from '../functions/_shared/kashier-signature.ts';

type Vector = {
  name: string;
  apiKey: string;
  data: Record<string, unknown>;
  signaturePayload: string;
  signature: string;
};

const fixture = JSON.parse(
  await Deno.readTextFile(new URL('./kashier-signature-vectors.json', import.meta.url)),
) as { generatedWith: Record<string, string>; vectors: Vector[] };

Deno.test('golden vectors were generated from the real query-string package', () => {
  assertEquals(fixture.generatedWith['query-string'], '7.1.3');
  assert(fixture.vectors.length >= 15, 'expected a meaningful number of vectors');
});

for (const vector of fixture.vectors) {
  Deno.test(`canonical payload matches query-string: ${vector.name}`, () => {
    assertEquals(buildSignaturePayload(vector.data), vector.signaturePayload);
  });

  Deno.test(`HMAC matches Node crypto: ${vector.name}`, async () => {
    const sig = await hmacSha256Hex(vector.signaturePayload, vector.apiKey);
    assertEquals(sig, vector.signature);
  });

  Deno.test(`end-to-end verification accepts the real signature: ${vector.name}`, async () => {
    const result = await verifyKashierSignature(vector.data, vector.signature, [
      { id: 'payment:test', secret: vector.apiKey },
    ]);
    assert(result.valid, `should have verified: ${result.reason}`);
    assertEquals(result.matchedKeyId, 'payment:test');
  });
}

// --- The rules that are easy to get wrong, asserted explicitly ---------------

Deno.test('sorting is UTF-16 code-unit order, not locale order', () => {
  // localeCompare would order these apple, Banana, Zebra — which would produce
  // a different signed string and reject every genuine delivery.
  const payload = buildSignaturePayload({
    Zebra: '1',
    apple: '2',
    Banana: '3',
    signatureKeys: ['Zebra', 'apple', 'Banana'],
  });
  assertEquals(payload, 'Banana=3&Zebra=1&apple=2');
});

Deno.test("strict encoding escapes !'()* and leaves ~.-_ alone", () => {
  assertEquals(strictUriEncode("it's!"), 'it%27s%21');
  assertEquals(strictUriEncode('(a)*b'), '%28a%29%2Ab');
  assertEquals(strictUriEncode('tilde~dot.dash-under_'), 'tilde~dot.dash-under_');
});

Deno.test('spaces encode as %20, never as +', () => {
  assertEquals(strictUriEncode('hello world'), 'hello%20world');
});

Deno.test('null emits a bare key; empty string emits key=', () => {
  assertEquals(buildSignaturePayload({ a: null, b: '', signatureKeys: ['a', 'b'] }), 'a&b=');
});

Deno.test('keys missing from data are dropped, matching underscore _.pick', () => {
  assertEquals(
    buildSignaturePayload({ a: 'present', signatureKeys: ['a', 'notThere'] }),
    'a=present',
  );
});

Deno.test('fields outside signatureKeys never enter the signed string', () => {
  const payload = buildSignaturePayload({
    amount: 100,
    secretField: 'must-not-appear',
    signatureKeys: ['amount'],
  });
  assertEquals(payload, 'amount=100');
});

// --- Rejection paths --------------------------------------------------------

Deno.test('rejects a tampered amount', async () => {
  const v = fixture.vectors[0];
  const tampered = { ...v.data, amount: 999999 };
  const result = await verifyKashierSignature(tampered, v.signature, [
    { id: 'payment:live', secret: v.apiKey },
  ]);
  assert(!result.valid, 'a tampered amount must not verify');
  assertEquals(result.reason, 'signature_mismatch');
});

Deno.test('rejects the right payload signed with the wrong key', async () => {
  const v = fixture.vectors[0];
  const result = await verifyKashierSignature(v.data, v.signature, [
    { id: 'payment:live', secret: 'a-different-key' },
  ]);
  assert(!result.valid);
  assertEquals(result.reason, 'signature_mismatch');
});

Deno.test('rejects a missing signature header', async () => {
  const v = fixture.vectors[0];
  const result = await verifyKashierSignature(v.data, null, [
    { id: 'payment:live', secret: v.apiKey },
  ]);
  assert(!result.valid);
  assertEquals(result.reason, 'missing_signature_header');
});

Deno.test('a payload with no signatureKeys is unverifiable, never trusted', async () => {
  const result = await verifyKashierSignature({ amount: 100 }, 'deadbeef', [
    { id: 'payment:live', secret: 'k' },
  ]);
  assert(!result.valid);
  assertEquals(result.reason, 'no_signature_keys_in_payload');
});

Deno.test('no configured keys means unverifiable, never trusted', async () => {
  const v = fixture.vectors[0];
  const result = await verifyKashierSignature(v.data, v.signature, []);
  assert(!result.valid);
  assertEquals(result.reason, 'no_api_keys_configured');
});

Deno.test('multi-key search finds the matching key and reports which one', async () => {
  const v = fixture.vectors[0];
  const result = await verifyKashierSignature(v.data, v.signature, [
    { id: 'payment:test', secret: 'wrong-1' },
    { id: 'transfer:live', secret: 'wrong-2' },
    { id: 'payment:live', secret: v.apiKey },
  ]);
  assert(result.valid);
  assertEquals(result.matchedKeyId, 'payment:live');
});

Deno.test('signature comparison is case-insensitive on the header', async () => {
  const v = fixture.vectors[0];
  const result = await verifyKashierSignature(v.data, v.signature.toUpperCase(), [
    { id: 'payment:live', secret: v.apiKey },
  ]);
  assert(result.valid, 'an upper-case hex digest is the same digest');
});

Deno.test('timingSafeEqual is correct for equal, different and unequal-length input', () => {
  assert(timingSafeEqual('abc123', 'abc123'));
  assert(!timingSafeEqual('abc123', 'abc124'));
  assert(!timingSafeEqual('abc', 'abcd'));
  assert(timingSafeEqual('', ''));
});
