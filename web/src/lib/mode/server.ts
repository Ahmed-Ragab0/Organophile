import { cookies } from 'next/headers';
import { DEFAULT_MODE, isMode, MODE_COOKIE, type Mode } from './mode';

/** Reads the mode for server rendering, so the switch is right on first paint. */
export async function getMode(): Promise<Mode> {
  const store = await cookies();
  const value = store.get(MODE_COOKIE)?.value;
  return isMode(value) ? value : DEFAULT_MODE;
}
