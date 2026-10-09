import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A button that opens a panel under it: the run picker, the export menu, past studies. Closes on
 * a click outside, on Escape, and when an item calls `close`.
 */
export function Menu({ label, children, align = 'left', buttonClass = '', panelClass = '', disabled = false, title }: {
  label: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  buttonClass?: string;
  panelClass?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button type="button" aria-haspopup="true" aria-expanded={open} disabled={disabled} title={title}
              onClick={() => setOpen((o) => !o)}
              className={`inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-[12px] text-[var(--color-text-secondary)] hover:border-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-40 ${open ? 'border-[var(--color-text-muted)] text-[var(--color-text-primary)]' : ''} ${buttonClass}`}>
        {label}
        <svg className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
          <path d="M3 4.5l3 3 3-3" />
        </svg>
      </button>
      {open && (
        <div role="menu"
             className={`absolute top-full z-30 mt-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] p-1 shadow-xl shadow-black/40 ${align === 'right' ? 'right-0' : 'left-0'} ${panelClass}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** One row of a Menu. */
export function MenuItem({ onClick, children, disabled = false, note, active = false }: {
  onClick: () => void; children: ReactNode; disabled?: boolean; note?: ReactNode; active?: boolean;
}) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick}
            className={`block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--color-bg-secondary)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent ${active ? 'bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'}`}>
      <span className="block text-[var(--color-text-primary)]">{children}</span>
      {note && <span className="mt-0.5 block text-[11px] leading-snug text-[var(--color-text-muted)]">{note}</span>}
    </button>
  );
}
