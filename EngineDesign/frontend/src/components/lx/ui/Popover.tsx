import { useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { placePopover } from './place';

/**
 * A card fixed beside its anchor: the hover cards and the menus. Rendered into the anchor's own
 * `.lx` root, so it keeps the theme tokens but escapes any panel's overflow or stacking. Placed by
 * `placePopover` after it is measured, and again on scroll and resize, so it stays on screen.
 */
export function Popover({
  open, anchor, children, role, id, ariaLabel, ariaLabelledBy, ariaHidden, prefer = 'below', align = 'start', className = '',
  style, onKeyDown, elRef, matchWidth = false,
}: {
  open: boolean;
  /** The element to place against (from useHover, or a menu's trigger). */
  anchor: HTMLElement | null;
  children: ReactNode;
  role?: string;
  id?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  /** A visual duplicate of a description already in the accessibility tree. */
  ariaHidden?: boolean;
  prefer?: 'below' | 'above';
  align?: 'start' | 'end';
  className?: string;
  style?: CSSProperties;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  elRef?: RefObject<HTMLDivElement | null>;
  /** At least as wide as the anchor (a menu under a wide button). */
  matchWidth?: boolean;
}) {
  const own = useRef<HTMLDivElement>(null);
  const ref = elRef ?? own;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !anchor || !el) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      if (matchWidth) el.style.minWidth = `${a.width}px`;
      const p = placePopover(a, { w: el.offsetWidth, h: el.offsetHeight }, { w: window.innerWidth, h: window.innerHeight }, { prefer, align });
      el.style.left = `${Math.round(p.left)}px`;
      el.style.top = `${Math.round(p.top)}px`;
      el.style.visibility = 'visible';
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchor, prefer, align, matchWidth, ref]);

  if (!open || !anchor) return null;
  const root = (anchor.closest('.lx') as HTMLElement | null) ?? document.body;
  return createPortal(
    <div ref={ref} id={id} role={role} aria-label={ariaLabel} aria-labelledby={ariaLabelledBy} aria-hidden={ariaHidden || undefined} onKeyDown={onKeyDown}
         className={`fixed z-[60] rounded-[6px] border border-[var(--lx-line)] bg-[var(--lx-surface)] text-[var(--lx-text)] ${className}`}
         style={{ left: 0, top: 0, visibility: 'hidden', boxShadow: 'var(--lx-shadow-pop)', ...style }}>
      {children}
    </div>,
    root,
  );
}
