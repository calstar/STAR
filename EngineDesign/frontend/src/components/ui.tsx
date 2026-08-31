/**
 * The modal shell shared by the design bar and its dialogs.
 *
 * `Modal` used to live inside DesignVersions.tsx; the sharing dialogs need the
 * same shell, so it moved here rather than being copied. Deliberately tiny --
 * this is not a component library, it is the shell everything that must not be
 * a `window.prompt` is built on. (recovery-calculator has a larger ui.tsx of
 * the same shape; this is the overlap.)
 *
 * Only the component lives here: react-refresh requires a file exporting a
 * component to export nothing else, so the button classes and relativeTime sit
 * in lib/ui.ts.
 */

import { useEffect } from 'react';
import type { ReactNode } from 'react';

/**
 * A centred, app-styled modal. The one dialog shell everything else builds on
 * -- prompts, confirmations, design history, the Change dialog -- so the app
 * never falls back to a browser alert/confirm/prompt, which cannot be themed
 * and land in the wrong place. Click the backdrop or press Escape to dismiss.
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
