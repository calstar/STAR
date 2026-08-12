/**
 * A fixed-position sidebar the user can drag to resize.
 *
 * The 3D view (`<main>`) between the two sidebars is `flex-1`, so it simply takes
 * whatever width the sidebars leave -- resizing one just hands space to or from the
 * viewport. The drag handle sits on the sidebar's *inner* edge (the edge facing the
 * viewport): the right edge for a left sidebar, the left edge for a right one. The
 * chosen width is remembered per `storageKey` so it survives reloads.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

interface Props {
  side: 'left' | 'right'
  defaultWidth: number
  min?: number
  max?: number
  /** localStorage key so the width persists across reloads. */
  storageKey: string
  className?: string
  children: React.ReactNode
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function ResizableSidebar({
  side,
  defaultWidth,
  min = 220,
  max = 680,
  storageKey,
  className = '',
  children,
}: Props) {
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(window.localStorage.getItem(storageKey))
    return Number.isFinite(saved) && saved > 0 ? clamp(saved, min, max) : defaultWidth
  })
  const [dragging, setDragging] = useState(false)
  // Drag origin, held in a ref so pointermove does not depend on render timing.
  const origin = useRef({ x: 0, width: 0 })

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      origin.current = { x: e.clientX, width }
      setDragging(true)
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    [width],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
      // Dragging toward the viewport widens the sidebar; the sign flips by side.
      const delta = e.clientX - origin.current.x
      const next = origin.current.width + (side === 'left' ? delta : -delta)
      setWidth(clamp(next, min, max))
    },
    [side, min, max],
  )

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
      setDragging(false)
    },
    [],
  )

  // Persist the settled width (not every intermediate frame).
  useEffect(() => {
    if (!dragging) window.localStorage.setItem(storageKey, String(Math.round(width)))
  }, [dragging, width, storageKey])

  const border = side === 'left' ? 'border-r' : 'border-l'

  return (
    <aside
      className={`relative shrink-0 ${border} border-slate-700 bg-slate-900/60 ${className}`}
      style={{ width }}
    >
      {children}

      {/* Drag handle on the inner edge. A wide invisible hit area with a thin
          visible line that lights up on hover / while dragging. */}
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={`group absolute top-0 z-10 h-full w-2 cursor-col-resize ${
          side === 'left' ? '-right-1' : '-left-1'
        }`}
        title="Drag to resize"
      >
        <div
          className={`mx-auto h-full w-px transition-colors ${
            dragging ? 'bg-cyan-400' : 'bg-transparent group-hover:bg-cyan-500/60'
          }`}
        />
      </div>
    </aside>
  )
}
