/**
 * The freeform fin "Shape" tab (FreeformFinSetConfig): the fin outline on a
 * grid with draggable points, beside the editable point table.
 *
 *   drag a point        move it (the first point stays at the root's front)
 *   double-click a line insert a point there
 *   ctrl/cmd-click      delete a point
 *
 * The first and last points sit on the root (y = 0), as OpenRocket requires.
 */
import { useRef, useState } from 'react'
import type { FinPoints } from '../../types'
import { points } from '../../lib/params'
import { fmtNumber } from '../../lib/units'
import { useUnits } from '../../workbench/units'
import { useEdit } from './fields'

const PW = 430
const PH = 300
const PAD = 26

export function constrain(pts: FinPoints): FinPoints {
  const out = pts.map(([x, y]) => [x, Math.max(0, y)] as [number, number])
  if (out.length) {
    out[0] = [0, 0]
    out[out.length - 1] = [Math.max(0, out[out.length - 1][0]), 0]
  }
  return out
}

export function FreeformShape() {
  const e = useEdit()
  const u = useUnits()
  const pts = points(e.c.params)
  const [sel, setSel] = useState<number | null>(null)
  const dragging = useRef<number | null>(null)
  const svg = useRef<SVGSVGElement>(null)

  const set = (next: FinPoints) => e.set('finpoints', constrain(next))

  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const xmin = Math.min(0, ...xs)
  const xmax = Math.max(0.01, ...xs)
  const ymax = Math.max(0.01, ...ys)
  const span = Math.max(xmax - xmin, ymax) * 1.15
  const s = Math.min((PW - 2 * PAD) / span, (PH - 2 * PAD) / span)
  const ox = PAD - xmin * s
  const oy = PH - PAD
  const X = (x: number) => ox + x * s
  const Y = (y: number) => oy - y * s
  const toWorld = (ev: React.MouseEvent | MouseEvent): [number, number] => {
    const r = svg.current!.getBoundingClientRect()
    return [(ev.clientX - r.left - ox) / s, (oy - (ev.clientY - r.top)) / s]
  }

  // Grid in the length unit.
  const unit = u.fromDisplay('length', 1)
  const pxPerUnit = unit * s
  const raw = 30 / pxPerUnit
  const p10 = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 5, 10].map((m) => m * p10).find((v) => v >= raw)! * unit
  const grid: number[] = []
  for (let v = Math.floor(xmin / step) * step; v <= span + xmin; v += step) grid.push(v)

  const startDrag = (i: number) => (ev: React.MouseEvent) => {
    ev.preventDefault()
    ev.stopPropagation()
    if (ev.ctrlKey || ev.metaKey) {
      if (pts.length > 3 && i !== 0 && i !== pts.length - 1) set(pts.filter((_, k) => k !== i))
      return
    }
    setSel(i)
    dragging.current = i
    const move = (m: MouseEvent) => {
      const k = dragging.current
      if (k == null) return
      const [wx, wy] = toWorld(m)
      const cur = points(e.c.params)
      const next = cur.map((p) => [...p] as [number, number])
      next[k] = [Math.max(k === 0 ? 0 : -1, wx), k === 0 || k === next.length - 1 ? 0 : Math.max(0, wy)]
      set(next)
    }
    const up = () => {
      dragging.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const insertAt = (ev: React.MouseEvent) => {
    const [wx, wy] = toWorld(ev)
    // nearest segment
    let best = 0
    let bd = Infinity
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i]
      const [x1, y1] = pts[i + 1]
      const dx = x1 - x0
      const dy = y1 - y0
      const t = Math.max(0, Math.min(1, ((wx - x0) * dx + (wy - y0) * dy) / (dx * dx + dy * dy || 1)))
      const d = Math.hypot(x0 + t * dx - wx, y0 + t * dy - wy)
      if (d < bd) {
        bd = d
        best = i
      }
    }
    const next = [...pts]
    next.splice(best + 1, 0, [wx, Math.max(0, wy)])
    set(next)
    setSel(best + 1)
  }

  const L = (v: number) => fmtNumber(u.toDisplay('length', v), u.digits('length') + 1)

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      <div>
        <svg
          ref={svg}
          width={PW}
          height={PH}
          style={{ background: 'white', border: '1px solid #a9a9a9', display: 'block' }}
          onDoubleClick={insertAt}
          data-testid="freeform-plot"
        >
          {grid.map((g, i) => (
            <g key={i}>
              <line x1={X(g)} x2={X(g)} y1={0} y2={PH} stroke="#e4e4e4" />
              <line y1={Y(g - xmin)} y2={Y(g - xmin)} x1={0} x2={PW} stroke="#e4e4e4" />
            </g>
          ))}
          {/* the body line (root) */}
          <line x1={0} x2={PW} y1={oy} y2={oy} stroke="#0000f0" strokeWidth={1} />
          <polygon points={pts.map(([x, y]) => `${X(x)},${Y(y)}`).join(' ')} fill="rgba(0,0,240,0.06)" stroke="#0000f0" strokeWidth={1.4} />
          {pts.map(([x, y], i) => (
            <rect
              key={i}
              x={X(x) - 4}
              y={Y(y) - 4}
              width={8}
              height={8}
              fill={i === sel ? '#ff3333' : 'white'}
              stroke={i === sel ? '#aa0000' : '#000'}
              style={{ cursor: 'move' }}
              onMouseDown={startDrag(i)}
              data-testid={`fin-point-${i}`}
            />
          ))}
        </svg>
        <div style={{ fontSize: 11.5, color: '#444', marginTop: 6, lineHeight: 1.5 }}>
          Click+drag: Move points&nbsp;&nbsp;&nbsp; Double-click: Add point&nbsp;&nbsp;&nbsp; Ctrl+click: Delete point
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ height: 262, width: 250, overflow: 'auto', border: '1px solid #a9a9a9', background: 'white' }}>
          <table className="orw-table">
            <thead>
              <tr>
                <th style={{ width: 30 }}>#</th>
                <th>X / {u.label('length')}</th>
                <th>Y / {u.label('length')}</th>
              </tr>
            </thead>
            <tbody>
              {pts.map(([x, y], i) => (
                <tr key={i} className={i === sel ? 'sel' : ''} onMouseDown={() => setSel(i)}>
                  <td style={{ textAlign: 'center' }}>{i}</td>
                  <td>
                    <CellInput
                      value={L(x)}
                      disabled={i === 0}
                      onCommit={(v) => set(pts.map((p, k) => (k === i ? [u.fromDisplay('length', v), p[1]] : p)))}
                    />
                  </td>
                  <td>
                    <CellInput
                      value={L(y)}
                      disabled={i === 0 || i === pts.length - 1}
                      onCommit={(v) => set(pts.map((p, k) => (k === i ? [p[0], u.fromDisplay('length', v)] : p)))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            className="orw-btn"
            disabled={sel == null || sel >= pts.length - 1}
            onClick={() => {
              if (sel == null) return
              const a = pts[sel]
              const b = pts[sel + 1]
              const next = [...pts]
              next.splice(sel + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
              set(next)
              setSel(sel + 1)
            }}
          >
            Insert point
          </button>
          <button
            type="button"
            className="orw-btn"
            disabled={sel == null || sel === 0 || sel === pts.length - 1 || pts.length <= 3}
            onClick={() => {
              if (sel == null) return
              set(pts.filter((_, k) => k !== sel))
              setSel(null)
            }}
          >
            Delete point
          </button>
        </div>
      </div>
    </div>
  )
}

function CellInput({ value, onCommit, disabled }: { value: string; onCommit: (v: number) => void; disabled?: boolean }) {
  const [text, setText] = useState<string | null>(null)
  return (
    <input
      value={text ?? value}
      disabled={disabled}
      style={{ width: '100%', border: 0, outline: 'none', background: 'transparent', color: 'inherit', textAlign: 'right' }}
      onFocus={() => setText(value)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const n = Number((text ?? '').replace(',', '.'))
        if (text != null && text.trim() !== '' && Number.isFinite(n)) onCommit(n)
        setText(null)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}
