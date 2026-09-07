import { cookies } from 'next/headers';
import { DEFAULT_THEME, isTheme, THEME_COOKIE, type Theme } from './theme';

/** Reads the theme for server rendering, so <html data-theme> is right on first paint. */
export async function getTheme(): Promise<Theme> {
  const store = await cookies();
  const value = store.get(THEME_COOKIE)?.value;
  return isTheme(value) ? value : DEFAULT_THEME;
}
