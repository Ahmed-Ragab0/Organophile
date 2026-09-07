/**
 * Typed access to Edge Function secrets.
 * Nothing here ever logs a secret value — only whether it is present.
 */

export function optionalEnv(name: string): string | null {
  const value = Deno.env.get(name);
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (value === null) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

export function boolEnv(name: string, fallback = false): boolean {
  const value = optionalEnv(name);
  if (value === null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export type KashierMode = 'test' | 'live';

/**
 * Candidate signing keys for a delivery.
 *
 * Kashier signs transaction events with the Payment API key and transfer
 * events with the Transfer API key, and each exists separately per mode. The
 * endpoint serves all of them, so it offers every plausible key to the
 * verifier and lets the matching one identify both the key type and the mode.
 */
export function candidateKeys(
  resource: 'transaction' | 'transfer' | 'unknown',
  restrictToMode: KashierMode | null,
): Array<{ id: string; secret: string }> {
  const entries: Array<{ id: string; env: string; kind: string; mode: KashierMode }> = [
    { id: 'payment:live', env: 'KASHIER_PAYMENT_API_KEY_LIVE', kind: 'transaction', mode: 'live' },
    { id: 'payment:test', env: 'KASHIER_PAYMENT_API_KEY_TEST', kind: 'transaction', mode: 'test' },
    { id: 'transfer:live', env: 'KASHIER_TRANSFER_API_KEY_LIVE', kind: 'transfer', mode: 'live' },
    { id: 'transfer:test', env: 'KASHIER_TRANSFER_API_KEY_TEST', kind: 'transfer', mode: 'test' },
  ];

  return entries
    .filter((e) => (resource === 'unknown' ? true : e.kind === resource))
    .filter((e) => (restrictToMode === null ? true : e.mode === restrictToMode))
    .map((e) => ({ id: e.id, secret: optionalEnv(e.env) }))
    .filter((e): e is { id: string; secret: string } => e.secret !== null);
}

/** 'payment:live' -> 'live'. Used to derive the mode from whichever key matched. */
export function modeFromKeyId(keyId: string | null): KashierMode | null {
  if (!keyId) return null;
  return keyId.endsWith(':test') ? 'test' : 'live';
}
