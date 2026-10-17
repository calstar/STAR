/**
 * The one dialog shell the design tools build on.
 *
 * Everything that would otherwise be a `window.prompt`/`confirm`/`alert` goes
 * through here instead, so it is centred, themed, and lands where the user is
 * looking. Deliberately tiny -- this is a shell, not a component library.
 */

import { useEffect, useId } from 'react';
import type { ReactNode } from 'react';

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
  // is announced as one rather than as more of the page behind it.
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`${width} max-w-[90vw] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-6 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId} className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</h3>
        {children && <div className="mt-4">{children}</div>}
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
