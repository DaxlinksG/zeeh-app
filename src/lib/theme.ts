/** Theme preference — "system" follows the OS, "dark"/"light" override it. */
export type ThemePreference = 'system' | 'dark' | 'light';

const STORAGE_KEY = 'zeeh-theme';

/** Read the stored preference (defaults to "system"). */
export function getThemePreference(): ThemePreference {
  return (localStorage.getItem(STORAGE_KEY) as ThemePreference) || 'system';
}

/** Apply a preference by setting / removing the data-theme attribute on <html>. */
export function applyTheme(pref: ThemePreference): void {
  const root = document.documentElement;
  if (pref === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', pref);
  }
}

/** Persist + apply a preference. */
export function setTheme(pref: ThemePreference): void {
  localStorage.setItem(STORAGE_KEY, pref);
  applyTheme(pref);
}

/** Call once on app boot — restores whatever the user last chose. */
export function initTheme(): void {
  applyTheme(getThemePreference());
}
