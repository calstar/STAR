/**
 * Non-component UI bits: button class strings and one date formatter.
 *
 * Separate from components/ui.tsx purely because react-refresh requires a file
 * exporting a component to export nothing else.
 *
 * These use the `--color-*` variables rather than the hardcoded `#1e293b` /
 * `#334155` hexes the diagram bar used to carry, so pid-designer picks up the
 * same palette as the other design tools instead of drifting from it.
 */

export const btn =
  'inline-flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-1 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-tertiary)] disabled:opacity-40';
export const primaryBtn =
  'inline-flex items-center gap-1 rounded border border-transparent bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-40';
export const dangerBtn =
  'inline-flex items-center gap-1 rounded border border-red-500/50 bg-red-500/10 px-3 py-1 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-40';
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
