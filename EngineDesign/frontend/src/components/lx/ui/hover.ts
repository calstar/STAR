import { useEffect, useRef, useState, type FocusEvent, type MouseEvent } from 'react';

/**
 * Open-on-hover-or-focus for a hover card. Hover waits a beat (so sweeping the mouse across a page
 * does not flash cards), focus opens at once (a keyboard user asked for it), Escape closes from
 * anywhere. The element that opened it is kept as `anchor` for the Popover to place against.
 */
export function useHover({ openDelay = 150, closeDelay = 80 }: { openDelay?: number; closeDelay?: number } = {}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const t = timer;
    return () => window.clearTimeout(t.current);
  }, []);

  const open = anchor !== null;
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { window.clearTimeout(timer.current); setAnchor(null); }
    };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [open]);

  const later = (fn: () => void, ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(fn, ms);
  };

  const handlers = {
    onMouseEnter: (e: MouseEvent<HTMLElement>) => { const el = e.currentTarget; later(() => setAnchor(el), openDelay); },
    onMouseLeave: () => later(() => setAnchor(null), closeDelay),
    onFocus: (e: FocusEvent<HTMLElement>) => {
      // Only the element itself taking focus, not a child passing through.
      if (e.target !== e.currentTarget) return;
      window.clearTimeout(timer.current);
      setAnchor(e.currentTarget);
    },
    onBlur: () => { window.clearTimeout(timer.current); setAnchor(null); },
  };

  return { open, anchor, close: () => setAnchor(null), handlers };
}
