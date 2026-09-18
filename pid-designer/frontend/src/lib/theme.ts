/**
 * Dark/light mode. Dark is the product default (index.css's bare `:root`),
 * so a first-ever visit with no stored preference renders correctly with no
 * theme.ts involved at all -- this module only has work to do once someone
 * has an opinion.
 */
export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'pid.theme.v1';

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
 *  React mounts (see main.tsx) so there is never a flash of the other theme. */
export function applyTheme(theme: Theme): void {
  if (theme === 'dark') {
    delete document.documentElement.dataset.theme; // `:root`'s bare values are already dark
  } else {
    document.documentElement.dataset.theme = theme;
  }
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* private mode / storage disabled -- the toggle still works, it just forgets */
  }
}
