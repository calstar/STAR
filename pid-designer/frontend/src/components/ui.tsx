/**
 * The modal shell and button the diagram bar and its dialogs are built on.
 *
 * pid-designer had no dialog component at all: New / Rename / Delete used
 * `window.prompt` and `window.confirm`, which cannot be themed and open in the
 * wrong place. EngineDesign and recovery-calculator both fixed that with this
 * same shell; this is the port. Deliberately tiny -- not a component library.
 */

import { useEffect } from 'react';
import type { ReactNode } from 'react';

/**
 * A centred, app-styled modal. Click the backdrop or press Escape to dismiss.
 */
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
        className={`${width} max-w-[90vw] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-6 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</h3>
        {children && <div className="mt-4">{children}</div>}
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
