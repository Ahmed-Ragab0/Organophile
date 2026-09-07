/**
 * Test vs live is a property of the whole session, not of one page.
 *
 * Kashier runs two parallel worlds with their own keys, their own transaction
 * ids and their own balances. Showing rows from both in one table is how you
 * end up reading a 500 EGP test transfer as money you are owed — which is
 * exactly what the Transfers page was doing.
 *
 * The mode lives in a cookie so the server renders the right thing on first
 * paint, the same way the locale does.
 */

export type Mode = 'live' | 'test';

export const MODE_COOKIE = 'organophile_mode';
export const DEFAULT_MODE: Mode = 'live';

export function isMode(value: unknown): value is Mode {
  return value === 'live' || value === 'test';
}

/**
 * Money is only ever counted in live mode.
 *
 * The wallet balances, the P&L and the reports all exclude test traffic at the
 * database level — that is the invariant that keeps the books reconciling, and
 * it is not something a UI toggle should be able to switch off. So the mode
 * switch filters what you can SEE (payments, transfers, ingest), never what
 * counts. Pages that show money say so out loud instead of silently ignoring
 * the switch.
 */
export const MONEY_IS_ALWAYS_LIVE = true;
