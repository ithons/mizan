import { useCallback, useState } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';

/**
 * Kept in localStorage rather than `app_preferences`. The server round trip cannot finish before
 * first paint, so a server-held preference guarantees a flash of the wrong theme on every cold
 * load; and on a single-owner, single-machine app a second copy of the value buys nothing but a
 * way for the two to disagree. The literal key is duplicated in client/index.html, which has to
 * read it synchronously before this module exists.
 */
const STORAGE_KEY = 'mizan-theme';

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** Falls back to 'system' when storage is unavailable, which is the correct answer anyway. */
export function readThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

/**
 * 'system' removes the attribute instead of resolving it, so the `prefers-color-scheme` media
 * query in index.css stays in charge and the app follows the OS live with no listener here.
 */
export function applyThemePreference(preference: ThemePreference): void {
  if (preference === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', preference);
}

function storeThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch (error) {
    console.warn('Theme preference could not be saved and will reset on reload.', error);
  }
}

export function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);

  const update = useCallback((next: ThemePreference) => {
    applyThemePreference(next);
    storeThemePreference(next);
    setPreference(next);
  }, []);

  return [preference, update];
}
