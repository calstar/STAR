/**
 * The one dialog shell the design tools build on.
 *
 * Everything that would otherwise be a `window.prompt`/`confirm`/`alert` goes
 * through here instead, so it is centred, themed, and lands where the user is
 * looking. Deliberately tiny -- this is a shell, not a component library.
 */

import { useEffect, useId, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard focus for a modal dialog, which `aria-modal` alone does not move.
 *
 * aria-modal confines a screen reader to the dialog; keyboard focus goes with
 * it, or Tab walks the page behind an overlay the reader no longer announces.
 * Onto the dialog itself (give it `tabIndex={-1}`), not its first button --
 * often the destructive one, and Enter on open must not press it -- unless a
 * field inside asked (autoFocus). Tab cycles inside; on close, focus goes back
 * to whatever opened it. Escape calls `onEscape`, when given.
 */
export function useModalFocus(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onEscape?: () => void,
): void {
  // The apps pass a fresh closure every render. Read through a ref so the effect
  // below runs once per opening: re-run per render, it handed focus back to the
  // opener and took it again, out of any field being typed in.
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dlg = ref.current;
    if (dlg && !dlg.contains(document.activeElement)) dlg.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        escape.current?.();
        return;
      }
      if (e.key !== 'Tab' || !dlg) return;
      // A dialog opened over this one owns the keyboard.
      const active = document.activeElement;
      const top = active instanceof Element ? active.closest('[aria-modal="true"]') : null;
      if (top && top !== dlg && !dlg.contains(top)) return;
      const items = Array.from(dlg.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        dlg.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const inside = dlg.contains(active);
      if (e.shiftKey && (!inside || active === first || active === dlg)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 'w-[440px]',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  // Named for a screen reader by its own title, and marked modal, so a dialog
  // is announced as one rather than as more of the page behind it; focus goes
  // with it (`useModalFocus`).
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog, open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`${width} max-w-[90vw] rounded-xl outline-none border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-6 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId} className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</h3>
        {children && <div className="mt-4">{children}</div>}
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
