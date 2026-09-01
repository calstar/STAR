/**
 * Small shared UI primitives.
 *
 * Both of them now come from `@stardesign-ui`, the design tools' shared UI:
 * the modal shell verbatim, and `Button` as a thin wrapper that adds this app's
 * read-only gating on top of the shared variant classes. What used to live here
 * was a fourth hand-maintained copy of the same four button styles, in a
 * different palette -- which is how the header ended up showing two accents at
 * once, the viewer's cyan on the tab bar and the shared blue on Take/Change.
 *
 * The wrapper stays because the gating is this app's own: `@stardesign-ui`
 * deliberately does not enforce read-only, since the editable surfaces have
 * nothing in common between the tools (see its README).
 */

import type { ReactNode } from 'react'

// The dialog shell is shared with the other design tools.
export { Modal } from '@stardesign-ui'
import { btn, primaryBtn, ghostBtn, dangerBtn, useReadOnly } from '@stardesign-ui'

const VARIANTS = {
  primary: primaryBtn,
  secondary: btn,
  ghost: ghostBtn,
  danger: dangerBtn,
} as const

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
  variant?: keyof typeof VARIANTS
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
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${VARIANTS[variant]} disabled:cursor-not-allowed`}
    >
      {children}
    </button>
  )
}
