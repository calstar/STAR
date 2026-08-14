/**
 * Small shared UI primitives (Button, Modal), slate-palette to match the viewer.
 *
 * Mirrors the recovery calculator's ui.tsx API so shared components (the design
 * bar) drop in unchanged; only the styling differs (Tailwind slate + cyan accent
 * here, CSS custom properties there).
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'

export function Button({
  onClick,
  children,
  variant = 'secondary',
  disabled,
  title,
}: {
  onClick: () => void
  children: ReactNode
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  disabled?: boolean
  title?: string
}) {
  const styles = {
    primary: 'bg-cyan-600 text-white hover:bg-cyan-500 border-transparent',
    secondary: 'border-slate-600 text-slate-100 hover:border-slate-400',
    ghost: 'border-transparent text-slate-300 hover:text-slate-100',
    danger: 'border-red-500/40 text-red-300 hover:bg-red-500/10',
  }[variant]
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  )
}

/** A centred, app-styled modal. Click the backdrop or press Escape to dismiss. */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 'w-[440px]',
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children?: ReactNode
  footer?: ReactNode
  width?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className={`${width} max-w-[90vw] rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
        {children && <div className="mt-4 text-slate-200">{children}</div>}
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  )
}
