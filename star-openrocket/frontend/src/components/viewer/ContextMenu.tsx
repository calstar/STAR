/**
 * Right-click menu.
 *
 * The browser's own menu is suppressed by calling preventDefault on the
 * `contextmenu` event at the trigger site; that event is cancelable, so no
 * other trick is needed. What this component adds is the housekeeping: closing
 * on an outside click, on Escape, or on scroll, and staying inside the viewport
 * when opened near an edge.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
  danger?: boolean
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const { width, height } = node.getBoundingClientRect()
    // Flip back inside the window rather than opening off-screen.
    setPosition({
      left: Math.min(x, window.innerWidth - width - 8),
      top: Math.min(y, window.innerHeight - height - 8),
    })
  }, [x, y])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    // `true` so these fire before the target's own handlers, which would
    // otherwise reopen the menu on the same gesture that should close it.
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: position.left, top: position.top }}
      className="fixed z-50 min-w-44 rounded border border-slate-600 bg-slate-800 py-1 text-sm shadow-xl"
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) => (
        <button
          key={index}
          role="menuitem"
          type="button"
          disabled={item.disabled}
          onClick={() => {
            item.onSelect()
            onClose()
          }}
          className={`block w-full px-3 py-1.5 text-left ${
            item.disabled
              ? 'cursor-default text-slate-500'
              : item.danger
                ? 'text-amber-300 hover:bg-slate-700'
                : 'text-slate-200 hover:bg-slate-700'
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
