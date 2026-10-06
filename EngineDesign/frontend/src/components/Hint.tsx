import { useId, useRef, useState, type ReactNode } from 'react';

/** The tooltip's widest, in px (Tailwind max-w-80). */
const TIP_W = 320;

/**
 * Hover or focus to read ``text``: where explanations live, so the page carries numbers and not
 * paragraphs. Keyboard-reachable; never the only place a number lives.
 *
 * The tooltip is not laid out until it is shown (an invisible one still widened the page past a
 * narrow screen), and it opens toward whichever side has room.
 */
export function Hint({ text, children, className = '', align }: {
  text: ReactNode; children: ReactNode; className?: string; align?: 'left' | 'right';
}) {
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState<'left' | 'right' | null>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    const room = r ? window.innerWidth - r.left : Infinity;
    setOpen(align ?? (room < TIP_W + 8 && r && r.right > TIP_W ? 'right' : 'left'));
  };
  const hide = () => setOpen(null);
  return (
    <span ref={ref} className={`relative inline-flex outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] rounded-sm ${className}`}
          tabIndex={0} aria-describedby={id}
          onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}
          onKeyDown={(e) => { if (e.key === 'Escape') hide(); }}>
      {children}
      <span id={id} role="tooltip"
            className={`pointer-events-none absolute ${open === 'right' ? 'right-0' : 'left-0'} top-full z-30 mt-1.5 w-max max-w-80 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2.5 py-1.5 text-[11px] font-normal leading-snug text-[var(--color-text-secondary)] shadow-lg ${open ? 'block' : 'hidden'}`}>
        {text}
      </span>
    </span>
  );
}

/** A small ⓘ that opens ``text`` on hover or focus. */
export function Info({ text, align = 'right' }: { text: ReactNode; align?: 'left' | 'right' }) {
  return (
    <Hint text={text} align={align}>
      <span className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-[var(--color-border)] text-[10px] leading-none text-[var(--color-text-secondary)]" aria-label="about this">i</span>
    </Hint>
  );
}
