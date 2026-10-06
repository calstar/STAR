import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Popover } from './Popover';
import { buttonClass, type ButtonSize, type ButtonVariant } from './styles';

const MenuContext = createContext<{ close: () => void } | null>(null);

const ITEMS = '[role="menuitem"]:not([disabled]),[role="menuitemradio"]:not([disabled]),[role="menuitemcheckbox"]:not([disabled])';

/**
 * A button that opens a menu under it: the run picker, compare, units, export. Ported from
 * components/layerx/Menu.tsx, with the keyboard a menu button owes: Enter, Space or ↓ opens on
 * the first item, ↑/↓/Home/End move, Escape closes back to the button, Tab closes and moves on.
 * Closes on a click outside and after an item is chosen. The menu flips to stay on screen.
 *
 * `children` is either the items, or `(close) => items` for an item that must close by hand.
 */
export function Menu({ label, children, align = 'start', disabled = false, title, ariaLabel, variant = 'ghost', size = 'md', caret = true,
  className = '', panelClassName = '', minWidth = 200 }: {
  label: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'start' | 'end';
  disabled?: boolean;
  title?: string;
  /** The button's name when `label` is an icon. Otherwise the label names both the button and
   * the menu. */
  ariaLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  caret?: boolean;
  className?: string;
  panelClassName?: string;
  minWidth?: number;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = anchor !== null;
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const menuId = useId();
  const triggerId = `${menuId}-trigger`;

  // The anchor is the trigger: refocusing it needs no ref, so `close` is safe to hand to children.
  const close = useCallback((refocus = true) => {
    if (refocus) anchor?.focus();
    setAnchor(null);
  }, [anchor]);
  const ctx = useMemo(() => ({ close: () => close(true) }), [close]);

  const items = () => Array.from(panel.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);

  // On open, focus the first item (or the last, opened with ↑); close on a click outside or a
  // document-level Escape (the mouse user whose focus is not in the menu).
  useEffect(() => {
    if (!open) return;
    const list = Array.from(panel.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
    (focusLast.current ? list[list.length - 1] : list[0])?.focus();
    focusLast.current = false;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !trigger.current?.contains(t)) close(false);
    };
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') close(true); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open, close]);

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusLast.current = e.key === 'ArrowUp';
      setAnchor(e.currentTarget);
    }
  };

  const onPanelKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (e.key === 'ArrowDown') next = list[(i + 1) % list.length];
    else if (e.key === 'ArrowUp') next = list[(i - 1 + list.length) % list.length];
    else if (e.key === 'Home') next = list[0];
    else if (e.key === 'End') next = list[list.length - 1];
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
    else if (e.key === 'Tab') { close(false); return; }
    if (next) { e.preventDefault(); next.focus(); }
  };

  return (
    <>
      <button ref={trigger} id={triggerId} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
              aria-label={ariaLabel} disabled={disabled} title={title}
              onClick={(e) => (open ? close(false) : setAnchor(e.currentTarget))} onKeyDown={onTriggerKey}
              className={`${buttonClass(variant, size)} ${open ? 'bg-[var(--lx-surface-2)]' : ''} ${className}`}>
        {label}
        {caret && (
          <svg className={`h-3 w-3 shrink-0 text-[var(--lx-text-3)] transition-transform duration-100 ${open ? 'rotate-180' : ''}`}
               viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
            <path d="M3 4.5l3 3 3-3" />
          </svg>
        )}
      </button>
      <Popover open={open} anchor={anchor} role="menu" id={menuId} ariaLabel={ariaLabel} ariaLabelledBy={ariaLabel ? undefined : triggerId}
               align={align} onKeyDown={onPanelKey} elRef={panel} className={`max-h-[min(420px,70vh)] overflow-y-auto p-1 ${panelClassName}`}
               style={{ minWidth }}>
        <MenuContext.Provider value={ctx}>
          {typeof children === 'function' ? children(() => close(true)) : children}
        </MenuContext.Provider>
      </Popover>
    </>
  );
}

/**
 * One row of a Menu. With `checked` it is a radio item (the selected unit, the compared run) and
 * shows a tick. Chosen, it closes the menu unless `keepOpen`.
 */
export function MenuItem({ onClick, children, note, disabled = false, checked, keepOpen = false, title, right }: {
  onClick: () => void;
  children: ReactNode;
  /** A second line: a run's context, what an export holds. */
  note?: ReactNode;
  disabled?: boolean;
  checked?: boolean;
  keepOpen?: boolean;
  title?: string;
  /** A trailing figure or shortcut. */
  right?: ReactNode;
}) {
  const ctx = useContext(MenuContext);
  return (
    <button type="button" role={checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={checked} tabIndex={-1}
            disabled={disabled} title={title}
            onClick={() => { onClick(); if (!keepOpen) ctx?.close(); }}
            className="flex w-full cursor-pointer items-start gap-2 rounded-[4px] px-2 py-1.5 text-left hover:bg-[var(--lx-surface-2)] focus-visible:bg-[var(--lx-surface-2)] focus-visible:-outline-offset-2 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent">
      {checked !== undefined && (
        <span aria-hidden className="w-3 shrink-0 pt-px text-[12px] leading-5 text-[var(--lx-accent)]">{checked ? '✓' : ''}</span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-5 text-[var(--lx-text)]">{children}</span>
        {note && <span className="block text-[11px] leading-snug text-[var(--lx-text-3)]">{note}</span>}
      </span>
      {right && <span className="shrink-0 pt-px text-[12px] leading-5 text-[var(--lx-text-3)]">{right}</span>}
    </button>
  );
}

/** A heading inside a menu: "Pinned", "Recent". */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <div role="presentation" className="px-2 pb-1 pt-2 text-[11px] text-[var(--lx-text-3)]">{children}</div>;
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-[var(--lx-line)]" />;
}
