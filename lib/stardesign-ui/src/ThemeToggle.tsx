import type { Theme } from './colorScheme';

/**
 * Sun for "switch to light," moon for "switch to dark" -- the icon shown is
 * always the theme a click would go *to*, matching how this pair of icons is
 * read everywhere else.
 *
 * Controlled rather than self-managing its own state: some hosts (a canvas
 * whose own library needs `colorMode` kept in sync, say) need the current
 * theme available outside this button too, so the source of truth stays
 * wherever the app already keeps its other UI state.
 */
export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {theme === 'dark' ? (
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="4" strokeWidth={2} />
          <path strokeLinecap="round" strokeWidth={2} d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
      )}
    </button>
  );
}
