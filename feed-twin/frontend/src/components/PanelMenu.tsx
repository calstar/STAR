/**
 * A panel's ⋯: what it shows, one checkbox an item.
 *
 * Small and grey on purpose -- it is set once per stand and then left alone,
 * so it should not compete with anything an operator reads during a run.
 * Closes on a click elsewhere or Escape.
 */

import { useEffect, useRef, useState } from 'react';

export interface MenuItem {
  id: string;
  label: string;
  /** Hidden, but drawn anyway because it needs to be seen (open, past NOP). */
  forced?: string;
  /** The drawing's sheet, on a stand with more than one. Items come grouped. */
  page?: string | null;
}

interface Props {
  title: string;
  items: MenuItem[];
  hidden: string[];
  onToggle: (id: string) => void;
  onAll: (show: boolean) => void;
}

export default function PanelMenu({ title, items, hidden, onToggle, onAll }: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const shown = items.filter((i) => !hidden.includes(i.id)).length;

  return (
    <div ref={box} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Choose what ${title} shows`}
        aria-expanded={open}
        title={`Choose what ${title} shows`}
        className={`px-1 font-mono text-[14px] leading-none tracking-[0.1em] transition-colors hover:text-[var(--ink-2)] ${
          open ? 'text-[var(--ink-2)]' : 'text-[var(--ink-4)]'
        }`}
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-56 border border-[var(--line-strong)] bg-[var(--color-bg-secondary)] py-2 shadow-[0_8px_24px_rgba(0,0,0,0.6)]">
          <div className="flex items-baseline justify-between px-3 pb-2">
            <span className="caps text-[10px]">Show</span>
            <span className="flex gap-2 font-mono text-[10px] text-[var(--ink-3)]">
              <button type="button" onClick={() => onAll(true)} className="hover:text-[var(--ink)]">
                all
              </button>
              <button type="button" onClick={() => onAll(false)} className="hover:text-[var(--ink)]">
                none
              </button>
            </span>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {items.map((i, n) => (
              <div key={i.id}>
                {i.page && i.page !== items[n - 1]?.page && (
                  <div className="caps px-3 pb-0.5 pt-1.5 text-[9px] text-[var(--ink-4)]">{i.page}</div>
                )}
                <label
                  className="flex cursor-pointer items-center gap-2.5 px-3 py-1 font-mono text-[12px] text-[var(--ink-2)] hover:bg-[var(--color-bg-tertiary)]"
                  title={i.forced}
                >
                  <input
                    type="checkbox"
                    checked={!hidden.includes(i.id)}
                    onChange={() => onToggle(i.id)}
                    className="accent-[var(--ink-2)]"
                  />
                  <span className="truncate">{i.label}</span>
                  {i.forced && hidden.includes(i.id) && (
                    <span className="ml-auto flex-shrink-0 text-[10px] uppercase tracking-[0.1em] text-[var(--color-warning)]">
                      showing
                    </span>
                  )}
                </label>
              </div>
            ))}
          </div>
          <div className="mt-1 border-t border-[var(--line)] px-3 pt-2 font-mono text-[10px] leading-snug text-[var(--ink-3)]">
            {shown} of {items.length}. Anything hidden comes back while it needs watching.
          </div>
        </div>
      )}
    </div>
  );
}
