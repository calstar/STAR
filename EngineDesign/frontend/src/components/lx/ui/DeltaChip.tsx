/**
 * The change against the compared run: "+1.2 %", mono 11 px on surface-2. Neutral on purpose,
 * because whether a change is good depends on the figure. Build the text with `deltaText`.
 */
export function DeltaChip({ text, title, className = '' }: { text: string | null | undefined; title?: string; className?: string }) {
  if (!text) return null;
  return (
    <span title={title}
          className={`lx-num inline-flex h-[18px] items-center whitespace-nowrap rounded-[4px] bg-[var(--lx-surface-2)] px-1.5 text-[11px] leading-none text-[var(--lx-text-2)] ${className}`}>
      {text}
    </span>
  );
}
