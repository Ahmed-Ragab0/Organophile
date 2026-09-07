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
export type KashierResource = 'transaction' | 'transfer' | 'unknown';

export type CandidateKey = {
  /** Stable label recorded on the raw event, e.g. 'payment:live#2'. */
  id: string;
  secret: string;
  mode: KashierMode;
  kind: 'transaction' | 'transfer';
};

/**
 * A merchant can hold several Payment API keys at once — this account has a
 * default key plus one named "يوكيرا" — and Kashier signs each webhook with
 * whichever key created that order. So every one of these variables accepts a
 * COMMA-SEPARATED list, and all of them are offered to the verifier.
 */
function splitKeys(envName: string): string[] {
  const raw = optionalEnv(envName);
  if (raw === null) return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

const SOURCES: Array<
  { env: string; label: string; kind: 'transaction' | 'transfer'; mode: KashierMode }
> = [
  { env: 'KASHIER_PAYMENT_API_KEY_LIVE', label: 'payment', kind: 'transaction', mode: 'live' },
  { env: 'KASHIER_PAYMENT_API_KEY_TEST', label: 'payment', kind: 'transaction', mode: 'test' },
  { env: 'KASHIER_TRANSFER_API_KEY_LIVE', label: 'transfer', kind: 'transfer', mode: 'live' },
  { env: 'KASHIER_TRANSFER_API_KEY_TEST', label: 'transfer', kind: 'transfer', mode: 'test' },
];

/**
 * Every configured key that could plausibly have signed this delivery, ordered
 * best guess first.
 *
 * Keys matching the event's resource type come first so the common case
 * verifies on the first try and is attributed correctly. The remaining keys
 * follow as a fallback: Kashier's docs say transfer events are signed with the
 * Transfer API key, but that key is not clearly surfaced in every dashboard, and
 * a delivery we could have verified must not be rejected over our own
 * uncertainty about which key was used.
 *
 * Trying more keys leaks nothing — each attempt is a full HMAC comparison that
 * either matches or does not, and the matched key is recorded on the raw event.
 */
export function candidateKeys(
  resource: KashierResource,
  restrictToMode: KashierMode | null,
): CandidateKey[] {
  const all: CandidateKey[] = [];

  for (const source of SOURCES) {
    if (restrictToMode !== null && source.mode !== restrictToMode) continue;
    const secrets = splitKeys(source.env);
    secrets.forEach((secret, index) => {
      all.push({
        id: `${source.label}:${source.mode}${index > 0 ? `#${index + 1}` : ''}`,
        secret,
        mode: source.mode,
        kind: source.kind,
      });
    });
  }

  if (resource === 'unknown') return all;
  return [
    ...all.filter((k) => k.kind === resource),
    ...all.filter((k) => k.kind !== resource),
  ];
}
