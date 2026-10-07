/**
 * The button styles and one date formatter shared by the design tools.
 *
 * Separate from the components because react-refresh requires a file exporting
 * a component to export nothing else -- mixing the two breaks fast refresh for
 * every consumer.
 *
 * These reference `--color-*` custom properties rather than fixed colours, so
 * each app renders them in its own palette. `tokens.css` is the canonical
 * definition of all twelve; an app imports that file rather than redefining
 * them, so there is one place these can drift out of sync, not three.
 */

export const btn =
  'inline-flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-1 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-tertiary)] disabled:opacity-40';
export const primaryBtn =
  'inline-flex items-center gap-1 rounded border border-transparent bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-40';
export const dangerBtn =
  'inline-flex items-center gap-1 rounded border border-[var(--color-danger)]/50 bg-[var(--color-danger)]/10 px-3 py-1 text-xs font-medium text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger)]/20 disabled:opacity-40';
export const warningBtn =
  'inline-flex items-center gap-1 rounded border border-[var(--color-warning)]/50 bg-[var(--color-warning)]/10 px-3 py-1 text-xs font-medium text-[var(--color-warning)] transition-colors hover:bg-[var(--color-warning)]/20 disabled:opacity-40';
export const successBtn =
  'inline-flex items-center gap-1 rounded border border-[var(--color-success)]/50 bg-[var(--color-success)]/10 px-3 py-1 text-xs font-medium text-[var(--color-success)] transition-colors hover:bg-[var(--color-success)]/20 disabled:opacity-40';
export const ghostBtn =
  'inline-flex items-center gap-1 rounded border border-transparent px-3 py-1 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:opacity-40';

/** "just now" / "12m ago" / "3d ago" -- coarse on purpose; exact times go in a title. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
