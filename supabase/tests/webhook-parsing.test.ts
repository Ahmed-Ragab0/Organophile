import { assertEquals } from 'jsr:@std/assert@1';
import {
  classifyEvent,
  classifyPayload,
  isCombinedEnvelope,
  parseMode,
  signedDataFor,
} from '../functions/_shared/webhook-parsing.ts';
import { extractBearerToken } from '../functions/_shared/http.ts';
import {
  buildSignaturePayload,
  hmacSha256Hex,
  verifyKashierSignature,
} from '../functions/_shared/kashier-signature.ts';
import { candidateKeys } from '../functions/_shared/env.ts';

Deno.test('classifyEvent routes each event to the key that signs it', () => {
  for (const e of ['pay', 'capture', 'authorize', 'refund', 'void', 'reversal']) {
    assertEquals(classifyEvent(e), 'transaction', e);
  }
  for (const e of ['INITIATED', 'TRANSFERRED', 'FAILED']) {
    assertEquals(classifyEvent(e), 'transfer', e);
  }
  // Transfer events are documented upper-case but are matched case-insensitively.
  assertEquals(classifyEvent('transferred'), 'transfer');
  // Transaction events are lower-case and must NOT match upper-case, so that a
  // future 'PAY' transfer status could never be mistaken for a payment.
  assertEquals(classifyEvent('PAY'), 'unknown');
  assertEquals(classifyEvent('something_new'), 'unknown');
  assertEquals(classifyEvent(null), 'unknown');
  assertEquals(classifyEvent(42), 'unknown');
});

Deno.test('parseMode only accepts the two real modes', () => {
  assertEquals(parseMode('test'), 'test');
  assertEquals(parseMode('live'), 'live');
  assertEquals(parseMode('LIVE'), null);
  assertEquals(parseMode('production'), null);
  assertEquals(parseMode(null), null);
});

Deno.test('isCombinedEnvelope only matches the Test-button shape', () => {
  assertEquals(isCombinedEnvelope({ isTestWebhook: true, transaction: {}, transfer: {} }), true);
  // A real delivery always has a top-level event, even if data mentions transfers.
  assertEquals(isCombinedEnvelope({ event: 'pay', data: {} }), false);
  assertEquals(isCombinedEnvelope({ transaction: {} }), false);
  assertEquals(isCombinedEnvelope({}), false);
});

Deno.test('extractBearerToken handles the scheme, casing, spacing and bare tokens', () => {
  assertEquals(extractBearerToken('Bearer abc123'), 'abc123');
  assertEquals(extractBearerToken('bearer abc123'), 'abc123');
  assertEquals(extractBearerToken('BEARER   abc123  '), 'abc123');
  assertEquals(extractBearerToken('abc123'), 'abc123');
  assertEquals(extractBearerToken(''), null);
  assertEquals(extractBearerToken(null), null);
  assertEquals(extractBearerToken('Bearer '), 'Bearer');
});

function clearKeys() {
  for (
    const n of [
      'KASHIER_PAYMENT_API_KEY_LIVE',
      'KASHIER_PAYMENT_API_KEY_TEST',
      'KASHIER_TRANSFER_API_KEY_LIVE',
      'KASHIER_TRANSFER_API_KEY_TEST',
    ]
  ) Deno.env.delete(n);
}

Deno.test('candidateKeys picks only keys that exist, resource-matching first', () => {
  clearKeys();
  Deno.env.set('KASHIER_PAYMENT_API_KEY_LIVE', 'plive');
  Deno.env.set('KASHIER_PAYMENT_API_KEY_TEST', 'ptest');
  Deno.env.set('KASHIER_TRANSFER_API_KEY_LIVE', 'tlive');

  // Transfer keys still appear, but only after the payment keys: a delivery we
  // could verify must never be rejected just because we guessed the type wrong.
  assertEquals(
    candidateKeys('transaction', null).map((k) => k.id),
    ['payment:live', 'payment:test', 'transfer:live'],
  );
  assertEquals(
    candidateKeys('transfer', null).map((k) => k.id),
    ['transfer:live', 'payment:live', 'payment:test'],
  );
  assertEquals(candidateKeys('transaction', 'test').map((k) => k.id), ['payment:test']);
  assertEquals(candidateKeys('unknown', null).length, 3);
  clearKeys();
});

Deno.test('a merchant with several Payment API keys gets all of them as candidates', () => {
  // This account holds a Default-Live-Key and one named "يوكيرا"; Kashier signs
  // each webhook with whichever key created that order.
  clearKeys();
  Deno.env.set(
    'KASHIER_PAYMENT_API_KEY_LIVE',
    '306dfdce-564b-4242-a1e4-9cb68bdca69a, e258efa9-76c2-4292-9d2c-1be415e8fde9',
  );

  const keys = candidateKeys('transaction', 'live');
  assertEquals(keys.map((k) => k.id), ['payment:live', 'payment:live#2']);
  assertEquals(keys[0].secret, '306dfdce-564b-4242-a1e4-9cb68bdca69a');
  // Whitespace around the comma must not become part of the secret.
  assertEquals(keys[1].secret, 'e258efa9-76c2-4292-9d2c-1be415e8fde9');
  assertEquals(keys.every((k) => k.mode === 'live'), true);
  clearKeys();
});

Deno.test('candidateKeys treats blank and empty list entries as unconfigured', () => {
  clearKeys();
  Deno.env.set('KASHIER_PAYMENT_API_KEY_LIVE', '   ');
  assertEquals(candidateKeys('transaction', 'live').length, 0);

  Deno.env.set('KASHIER_PAYMENT_API_KEY_LIVE', 'a,,  ,b');
  assertEquals(candidateKeys('transaction', 'live').map((k) => k.secret), ['a', 'b']);
  clearKeys();
});

Deno.test('each candidate carries its own mode, so no id parsing is needed', () => {
  clearKeys();
  Deno.env.set('KASHIER_PAYMENT_API_KEY_LIVE', 'x,y');
  Deno.env.set('KASHIER_PAYMENT_API_KEY_TEST', 'z');

  const byId = Object.fromEntries(candidateKeys('transaction', null).map((k) => [k.id, k.mode]));
  assertEquals(byId['payment:live'], 'live');
  assertEquals(byId['payment:live#2'], 'live');
  assertEquals(byId['payment:test'], 'test');
  clearKeys();
});

// --- Real payloads captured from live Kashier deliveries ---------------------

Deno.test('a flat transfer delivery is classified as transfer, not unknown', () => {
  // Exactly what a configured Transfer webhook posted on 2026-09-07 12:35.
  // There is no top-level `event`; the state is in `status`.
  const flatTransfer = {
    isTestWebhook: true,
    transferId: 'TEST-TRS-0001',
    amount: 100,
    method: 'wallet',
    recipientName: 'Test Recipient',
    recipientNumber: '01000000000',
    merchantTransferId: 'TEST-TRANSFER-0001',
    status: 'TRANSFERRED',
    date: '2026-09-07T12:12:05.602Z',
    signatureKeys: ['merchantTransferId', 'method', 'amount', 'merchantId', 'status'],
  };

  // Classifying this 'unknown' would route it to the transaction projection,
  // which rejects anything without a transactionId.
  assertEquals(classifyPayload(flatTransfer), 'transfer');
  const asRecord = flatTransfer as Record<string, unknown>;
  assertEquals(classifyEvent(asRecord.event), 'unknown', 'there is genuinely no event field');
});

Deno.test('a transaction delivery still classifies from its top-level event', () => {
  assertEquals(classifyPayload({ event: 'pay', data: { transactionId: 'T' } }), 'transaction');
  assertEquals(classifyPayload({ event: 'refund', data: {} }), 'transaction');
  assertEquals(classifyPayload({ nothing: true }), 'unknown');
});

Deno.test('signedDataFor picks the object that actually carries signatureKeys', () => {
  // Transaction: nested under `data`.
  const txn = { event: 'pay', data: { transactionId: 'T', signatureKeys: ['transactionId'] } };
  assertEquals(signedDataFor(txn), txn.data);

  // Transfer: flat, signed as-is. Reading `.data` here would yield undefined
  // and the delivery would be refused as unverifiable.
  const transfer = { transferId: 'TR', status: 'TRANSFERRED', signatureKeys: ['status'] };
  assertEquals(signedDataFor(transfer), transfer);
});

Deno.test('the flat transfer object is verifiable end to end', async () => {
  const secret = 'transfer-key-under-test';
  const transfer = {
    transferId: 'TEST-TRS-0001',
    merchantTransferId: 'TEST-TRANSFER-0001',
    method: 'wallet',
    amount: 100,
    merchantId: 'MID-48090-321',
    status: 'TRANSFERRED',
    signatureKeys: ['merchantTransferId', 'method', 'amount', 'merchantId', 'status'],
  };

  const canonical = buildSignaturePayload(signedDataFor(transfer));
  // Sorted UTF-16, so 'amount' precedes 'merchantId' precedes 'merchantTransferId'.
  assertEquals(
    canonical,
    'amount=100&merchantId=MID-48090-321&merchantTransferId=TEST-TRANSFER-0001&method=wallet&status=TRANSFERRED',
  );

  const signature = await hmacSha256Hex(canonical!, secret);
  const verdict = await verifyKashierSignature(signedDataFor(transfer), signature, [
    { id: 'transfer:test', secret },
  ]);
  assertEquals(verdict.valid, true, verdict.reason ?? '');
});
