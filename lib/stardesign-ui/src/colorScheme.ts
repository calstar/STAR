/**
 * Dark/light mode for any app that imports tokens.css.
 *
 * One shared localStorage key across every STAR tool that adopts this: each
 * app is a separate origin, so there is no collision risk, and a team member
 * who prefers light mode gets it consistently if these tools are ever
 * consolidated under one domain later.
 */
export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'star-tools.theme.v1';

export function getStoredTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null; // private mode / storage disabled -- falls back to the default
  }
}

export function getInitialTheme(): Theme {
  return getStoredTheme() ?? 'dark';
}

/** Applies the theme to the document and remembers it. Safe to call before
 *  React mounts (see each app's main.tsx) so there is never a flash of the
 *  other theme. */
export function applyTheme(theme: Theme): void {
  if (theme === 'dark') {
    delete document.documentElement.dataset.theme; // tokens.css's bare `:root` is already dark
  } else {
    document.documentElement.dataset.theme = theme;
  }
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* private mode / storage disabled -- the toggle still works, it just forgets */
  }
}
