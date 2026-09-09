/**
 * Pure request-shaping helpers, kept out of the handler modules so they can be
 * unit tested without Deno.serve booting a listener at import time.
 */
import type { KashierMode } from './env.ts';

export const TRANSACTION_EVENTS = new Set([
  'pay',
  'capture',
  'authorize',
  'refund',
  'void',
  'reversal',
]);
export const TRANSFER_EVENTS = new Set(['INITIATED', 'TRANSFERRED', 'FAILED']);

/** Which Kashier resource an event name belongs to, and therefore which key signs it. */
export type Resource = 'transaction' | 'transfer' | 'unknown';

export function classifyEvent(event: unknown): Resource {
  if (typeof event !== 'string') return 'unknown';
  if (TRANSACTION_EVENTS.has(event)) return 'transaction';
  if (TRANSFER_EVENTS.has(event.toUpperCase())) return 'transfer';
  return 'unknown';
}

export function parseMode(value: string | null): KashierMode | null {
  return value === 'test' || value === 'live' ? value : null;
}

/**
 * The dashboard Test button sends `{ isTestWebhook, transaction: {...},
 * transfer: {...} }` when one webhook covers both resource types.
 */
export function isCombinedEnvelope(payload: Record<string, unknown>): boolean {
  return 'transaction' in payload && 'transfer' in payload && !('event' in payload);
}

/**
 * Classify a whole delivery, not just its `event` field.
 *
 * Transaction deliveries carry a top-level `event`. A configured TRANSFER
 * webhook does not: it posts the flat transfer object, where the state lives in
 * `status` and the only clue to the resource is a transfer identifier. Observed
 * live:
 *
 *   { "isTestWebhook": true, "transferId": "TEST-TRS-0001", "amount": 100,
 *     "method": "wallet", "status": "TRANSFERRED", ... }
 *
 * Classifying that as 'unknown' would route it to the transaction projection,
 * which would reject it for having no transactionId.
 */
export function classifyPayload(payload: Record<string, unknown>): Resource {
  const byEvent = classifyEvent(payload.event);
  if (byEvent !== 'unknown') return byEvent;

  const hasTransferId = typeof payload.transferId === 'string' ||
    typeof payload.merchantTransferId === 'string' ||
    typeof payload.transfer_id === 'string';

  if (hasTransferId) return 'transfer';
  return 'unknown';
}

/**
 * The object Kashier actually signed.
 *
 * Transaction payloads nest it under `data`; transfer payloads are flat and are
 * signed as-is. `signatureKeys` always lives alongside the signed fields, so
 * picking the wrong object yields a null canonical string and the delivery is
 * refused as unverifiable rather than wrongly accepted.
 */
export function signedDataFor(payload: Record<string, unknown>): unknown {
  return payload.data !== undefined ? payload.data : payload;
}
