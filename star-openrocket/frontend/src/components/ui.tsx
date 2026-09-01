/**
 * Small shared UI primitives, slate-palette to match the viewer.
 *
 * The modal shell is the design tools' shared one (`@stardesign-ui`) rather
 * than a fourth copy of the same dialog; it is themed by the same
 * `--color-*` custom properties index.css already defines. `Button` stays
 * local because its palette is this app's, but it consults the same read-only
 * context as the other tools' buttons do.
 */

import type { ReactNode } from 'react'

// The dialog shell is shared with the other design tools.
export { Modal } from '@stardesign-ui'
import { useReadOnly } from '@stardesign-ui'

export function Button({
  onClick,
  children,
  variant = 'secondary',
  disabled: ownDisabled,
  title,
  action = false,
}: {
  onClick: () => void
  children: ReactNode
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  disabled?: boolean
  title?: string
  /**
   * True for a button that does not change the design -- Run, Export, a view
   * toggle. Those stay live when the design is read-only.
   *
   * The default is the safe one: a button mutates until it says otherwise, so a
   * new one added later cannot quietly stay clickable without a checkout.
   */
  action?: boolean
}) {
  const readOnly = useReadOnly()
  const disabled = ownDisabled || (!action && readOnly)
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
