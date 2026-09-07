/**
 * Light, dark, or whatever the machine says.
 *
 * Kept as three states rather than a two-way toggle: "follow the system" is a
 * real preference, and a toggle that silently pins the theme takes it away
 * from someone whose laptop switches at sunset.
 *
 * Stored in a cookie and rendered on the server as `data-theme` on <html>, so
 * the first paint is already the right colour. A theme applied by JS after
 * hydration flashes white, which on a dark-mode dashboard is genuinely
 * unpleasant at night.
 */

export type Theme = 'system' | 'light' | 'dark';

export const THEME_COOKIE = 'organophile_theme';
export const DEFAULT_THEME: Theme = 'system';

export function isTheme(value: unknown): value is Theme {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** system → light → dark → system. */
export function nextTheme(current: Theme): Theme {
  return current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system';
}
