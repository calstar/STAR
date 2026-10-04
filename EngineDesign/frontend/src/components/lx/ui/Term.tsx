import { useId, type ReactNode } from 'react';
import { GLOSSARY, glossaryText, type GlossaryEntry, type GlossaryKey } from '../glossary';
import { useHover } from './hover';
import { Popover } from './Popover';

/** The glossary card: what a term is, its equation, where it comes from, what the model resolves. */
export function GlossaryCard({ entry, children }: { entry: GlossaryEntry; children?: ReactNode }) {
  return (
    <span className="block w-[min(320px,calc(100vw-16px))] px-3 py-2.5 text-left">
      <span className="block text-[13px] font-medium text-[var(--lx-text)]">{entry.term}</span>
      <span className="mt-1 block text-[12px] leading-[1.45] text-[var(--lx-text-2)]">{entry.short}</span>
      {entry.equation && (
        <span className="lx-num mt-2 block rounded-[4px] bg-[var(--lx-surface-2)] px-2 py-1 text-[12px] text-[var(--lx-text)]">{entry.equation}</span>
      )}
      {children}
      {(entry.resolution || entry.source) && (
        <span className="mt-2 block space-y-0.5 text-[11px] leading-snug text-[var(--lx-text-3)]">
          {entry.resolution && <span className="block">Resolution {entry.resolution}</span>}
          {entry.source && <span className="block">{entry.source}</span>}
        </span>
      )}
    </span>
  );
}

/**
 * A glossary term on the page: dotted underline, and its card on hover or focus. Focusable, so a
 * keyboard reaches it; Escape closes it; the card flips to stay on screen. The same text is the
 * term's accessible description.
 */
export function Term({ k, children, className = '' }: { k: GlossaryKey; children?: ReactNode; className?: string }) {
  const entry = GLOSSARY[k];
  const id = useId();
  const { open, anchor, handlers } = useHover();
  return (
    <>
      <span tabIndex={0} aria-describedby={id} {...handlers}
            className={`cursor-help rounded-[2px] underline decoration-[var(--lx-text-3)] decoration-dotted decoration-1 underline-offset-[3px] ${className}`}>
        {children ?? entry.term}
      </span>
      {/* Hidden, not sr-only: a Term inside a <label> must not pour its card into the field's name.
          aria-describedby still reads a hidden node it points at. */}
      <span id={id} hidden>{glossaryText(entry)}</span>
      <Popover open={open} anchor={anchor} ariaHidden className="pointer-events-none">
        <GlossaryCard entry={entry} />
      </Popover>
    </>
  );
}
