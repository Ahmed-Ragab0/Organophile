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
export function classifyEvent(event: unknown): 'transaction' | 'transfer' | 'unknown' {
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
 * transfer: {...} }` when one webhook covers both resource types. Real
 * deliveries always carry a top-level `event`.
 */
export function isCombinedEnvelope(payload: Record<string, unknown>): boolean {
  return 'transaction' in payload && 'transfer' in payload && !('event' in payload);
}

/**
 * Accepts `Bearer <token>` and, defensively, a bare token — some senders omit
 * the scheme. Returns null when nothing usable is present.
 */
export function extractBearerToken(header: string | null): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  return (match ? match[1] : trimmed).trim() || null;
}
