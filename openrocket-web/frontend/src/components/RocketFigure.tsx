/**
 * The side view (OpenRocket's ScaleScrollPane + RocketFigure + RocketInfo):
 * rulers on top and left, the figure drawn ONLY from Analysis.figure, the CG
 * and CP carets on the axis, and RocketInfo's overlay texts.
 *
 * Line styles follow OpenRocket's defaults: body components, fins and lugs
 * solid blue; structural internals solid magenta; mass objects dashed black;
 * recovery devices dashed red; motors grey-filled.
 */
import { useMemo, useRef, useState } from 'react'
import type { Analysis, Component, ComponentType, FigureShape, RocketDocument } from '../types'
import { useSize } from '../workbench/hooks'
import { useUnits } from '../workbench/units'
import { fmtNumber, fmtSig } from '../lib/units'

export const PX_PER_M_AT_100 = 3928 // OpenRocket's 100 % zoom on this display (fit of 1260 px = 75.4 %)
const RULER = 20
const MARGIN_X = 35
const MARGIN_Y = 30

export interface View {
  /** null = fit. */
  zoom: number | null
  /** World point at the figure centre, m. null = fitted centre. */
  cx: number | null
  cy: number | null
}

const STRUCTURAL: ReadonlySet<ComponentType> = new Set(['innertube', 'tubecoupler', 'centeringring', 'bulkhead', 'engineblock'])

function styleFor(s: FigureShape, type: ComponentType | undefined) {
  if (s.kind === 'motor') return { stroke: 'var(--or-fig-motor-line)', fill: 'var(--or-fig-motor-fill)', dash: undefined }
  if (s.kind === 'recovery') return { stroke: 'var(--or-fig-recovery)', fill: 'none', dash: '5 4' }
  if (s.kind === 'internal') {
    if (type && STRUCTURAL.has(type)) return { stroke: 'var(--or-fig-internal)', fill: 'none', dash: undefined }
    if (type === 'nosecone' || type === 'transition' || type === 'bodytube') return { stroke: 'var(--or-fig-body)', fill: 'none', dash: undefined }
    return { stroke: 'var(--or-fig-mass)', fill: 'none', dash: '5 4' }
  }
  return { stroke: 'var(--or-fig-body)', fill: 'none', dash: undefined }
}

/** Draw order: bodies under everything, motor last (OpenRocket's displayOrder_side, roughly). */
const ORDER: Record<FigureShape['kind'], number> = { body: 0, motor: 1, fin: 2, internal: 3, recovery: 4 }

function pointInPolygon(x: number, y: number, pts: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]
    const [xj, yj] = pts[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-300) + xi) inside = !inside
  }
  return inside
}

function polyArea(pts: [number, number][]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % pts.length]
    a += x0 * y1 - x1 * y0
  }
  return Math.abs(a / 2)
}

function niceStep(pxPerUnit: number, minPx: number): number {
  const raw = minPx / pxPerUnit
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p
  return 10 * p
}

export function CgGlyph({ size = 12 }: { size?: number }) {
  const r = size / 2 - 0.5
  return (
    <svg width={size} height={size} viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} aria-hidden style={{ verticalAlign: '-1px' }}>
      <CgMarker x={0} y={0} r={r} />
    </svg>
  )
}

export function CpGlyph({ size = 12 }: { size?: number }) {
  const r = size / 2 - 0.5
  return (
    <svg width={size} height={size} viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} aria-hidden style={{ verticalAlign: '-1px' }}>
      <CpMarker x={0} y={0} r={r} />
    </svg>
  )
}

function CgMarker({ x, y, r }: { x: number; y: number; r: number }) {
  // CGCaret: a blue and white quartered disc.
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r={r} fill="white" stroke="#1a1aff" strokeWidth={1.2} />
      <path d={`M0 0 L${-r} 0 A${r} ${r} 0 0 1 0 ${-r} Z`} fill="#1a1aff" />
      <path d={`M0 0 L${r} 0 A${r} ${r} 0 0 1 0 ${r} Z`} fill="#1a1aff" />
    </g>
  )
}

function CpMarker({ x, y, r }: { x: number; y: number; r: number }) {
  // CPCaret: a red disc with a pale halo.
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r={r} fill="#ffb3b3" />
      <circle r={r * 0.72} fill="#ff0000" />
    </g>
  )
}

export function RocketFigure({
  doc, analysis, selectedId, onSelect, onEdit, view, setView, showCgCp, showWarnings, configLabel, provenance,
}: {
  doc: RocketDocument
  analysis: Analysis | null
  selectedId: string | null
  onSelect: (id: string | null) => void
  onEdit: (id: string) => void
  view: View
  setView: (v: View) => void
  showCgCp: boolean
  showWarnings: boolean
  configLabel: string
  provenance: string
}) {
  const u = useUnits()
  const [ref, size] = useSize<HTMLDivElement>()
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null)
  const [hover, setHover] = useState(false)

  const types = useMemo(() => {
    const m = new Map<string, Component>()
    const visit = (c: Component) => {
      m.set(c.id, c)
      c.children.forEach(visit)
    }
    visit(doc.rocket)
    return m
  }, [doc.rocket])

  const W = Math.max(0, size.w - RULER)
  const H = Math.max(0, size.h - RULER)
  const b = analysis?.figure.bounds ?? { xmin: 0, xmax: 0.4, ymin: -0.05, ymax: 0.05 }
  const bw = Math.max(1e-6, b.xmax - b.xmin)
  const bh = Math.max(1e-6, b.ymax - b.ymin)
  const fitScale = Math.max(1, Math.min((W - 2 * MARGIN_X) / bw, (H - 2 * MARGIN_Y) / bh))
  const scale = view.zoom == null ? fitScale : view.zoom * PX_PER_M_AT_100
  const cx = view.cx ?? (b.xmin + b.xmax) / 2
  const cy = view.cy ?? 0
  const sx = (x: number) => (x - cx) * scale + W / 2
  const sy = (y: number) => H / 2 - (y - cy) * scale
  const wx = (px: number) => (px - W / 2) / scale + cx
  const wy = (py: number) => cy - (py - H / 2) / scale

  const shapes = useMemo(() => {
    const list = analysis?.figure.shapes ?? []
    return [...list].sort((a, z) => ORDER[a.kind] - ORDER[z.kind])
  }, [analysis])

  const hit = (px: number, py: number): string | null => {
    const x = wx(px)
    const y = wy(py)
    const tol = 3 / scale
    let best: { id: string; area: number } | null = null
    for (const s of shapes) {
      if (s.kind === 'motor') continue
      const inside = pointInPolygon(x, y, s.points) || s.points.some(([a, c]) => Math.abs(a - x) < tol && Math.abs(c - y) < tol)
      if (!inside) continue
      const area = polyArea(s.points)
      if (!best || area < best.area) best = { id: s.id, area }
    }
    return best?.id ?? null
  }

  const local = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return { px: e.clientX - r.left, py: e.clientY - r.top }
  }

  // Rulers in the length unit; label every ~5 cm-ish step that is >= 90 px.
  const unitM = u.fromDisplay('length', 1)
  const pxPerUnit = unitM * scale
  const major = niceStep(pxPerUnit, 90)
  const minor = major / (String(major).startsWith('2') ? 4 : 5)
  const ticksX: { v: number; px: number; major: boolean; mid: boolean }[] = []
  const ticksY: { v: number; px: number; major: boolean; mid: boolean }[] = []
  if (W > 0 && H > 0 && minor > 0) {
    const x0 = Math.floor(wx(0) / unitM / minor) * minor
    for (let v = x0; v * unitM <= wx(W); v += minor) {
      const k = Math.round(v / minor)
      ticksX.push({ v, px: sx(v * unitM), major: Math.abs(v / major - Math.round(v / major)) < 1e-6, mid: k % 5 === 0 })
      if (ticksX.length > 2000) break
    }
    const y0 = Math.floor(wy(H) / unitM / minor) * minor
    for (let v = y0; v * unitM <= wy(0); v += minor) {
      const k = Math.round(v / minor)
      ticksY.push({ v, px: sy(v * unitM), major: Math.abs(v / major - Math.round(v / major)) < 1e-6, mid: k % 5 === 0 })
      if (ticksY.length > 2000) break
    }
  }

  const a = analysis
  const hasMotors = !!a && a.cg.mass - a.cgEmpty.mass > 1e-9
  const L = (si: number, d?: number) => u.fmt('length', si, d)
  const mass = (si: number) => u.fmt('mass', si)
  const fmt2 = (si: number) => u.fmt('length', si)

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0, border: '1px solid #c0c0c0', background: 'var(--or-bg)' }}>
      <div ref={ref} style={{ position: 'absolute', inset: 0 }}>
        {/* corner */}
        <div className="orw-ruler" style={{ left: 0, top: 0, width: RULER, height: RULER, fontSize: 9, display: 'grid', placeItems: 'center', borderRight: '1px solid #e0e0e0' }}>
          {u.label('length')}
        </div>
        {/* top ruler */}
        <div className="orw-ruler" style={{ left: RULER, top: 0, right: 0, height: RULER }}>
          <svg width={W} height={RULER} style={{ display: 'block' }}>
            {ticksX.map((t, i) => (
              <g key={i}>
                <line x1={t.px} x2={t.px} y1={RULER} y2={RULER - (t.major ? 12 : t.mid ? 7 : 5)} stroke="#000" strokeWidth={1} shapeRendering="crispEdges" />
                {t.major && (
                  <text x={t.px + 1} y={9} fontSize={9.5} textAnchor="middle" fontWeight={Math.abs(t.v % (major * 2)) < 1e-9 ? 600 : 400}>
                    {fmtNumber(t.v, 3)}
                  </text>
                )}
              </g>
            ))}
          </svg>
        </div>
        {/* left ruler */}
        <div className="orw-ruler" style={{ left: 0, top: RULER, width: RULER, bottom: 0 }}>
          <svg width={RULER} height={H} style={{ display: 'block' }}>
            {ticksY.map((t, i) => (
              <g key={i}>
                <line y1={t.px} y2={t.px} x1={RULER} x2={RULER - (t.major ? 9 : t.mid ? 7 : 5)} stroke="#000" strokeWidth={1} shapeRendering="crispEdges" />
                {t.major && (
                  <text x={2} y={t.px - 2} fontSize={9.5}>
                    {fmtNumber(t.v, 3)}
                  </text>
                )}
              </g>
            ))}
          </svg>
        </div>

        {/* the figure */}
        <div
          className="orw-figure-wrap"
          style={{ position: 'absolute', left: RULER, top: RULER, right: 0, bottom: 0, cursor: drag.current?.moved ? 'grabbing' : hover ? 'pointer' : 'default' }}
          data-testid="rocket-figure"
          onMouseDown={(e) => {
            const { px, py } = local(e)
            drag.current = { x: px, y: py, cx, cy, moved: false }
          }}
          onMouseMove={(e) => {
            const { px, py } = local(e)
            const d = drag.current
            if (d && (e.buttons & 1)) {
              if (Math.abs(px - d.x) + Math.abs(py - d.y) > 3) d.moved = true
              if (d.moved) setView({ zoom: scale / PX_PER_M_AT_100, cx: d.cx - (px - d.x) / scale, cy: d.cy + (py - d.y) / scale })
            } else {
              setHover(hit(px, py) !== null)
            }
          }}
          onMouseUp={(e) => {
            const d = drag.current
            drag.current = null
            if (d && !d.moved) {
              const { px, py } = local(e)
              onSelect(hit(px, py))
            }
          }}
          onMouseLeave={() => {
            drag.current = null
            setHover(false)
          }}
          onDoubleClick={(e) => {
            const { px, py } = local(e)
            const id = hit(px, py)
            if (id) onEdit(id)
          }}
          onWheel={(e) => {
            const { px, py } = local(e)
            const f = Math.exp(-e.deltaY * 0.0015)
            const ns = Math.min(200 * PX_PER_M_AT_100, Math.max(0.02 * PX_PER_M_AT_100, scale * f))
            // keep the point under the cursor fixed
            const x = wx(px)
            const y = wy(py)
            setView({ zoom: ns / PX_PER_M_AT_100, cx: x - (px - W / 2) / ns, cy: y + (py - H / 2) / ns })
          }}
        >
          <svg width={W} height={H} style={{ display: 'block' }}>
            {shapes.map((s, i) => {
              const c = types.get(s.id)
              const st = styleFor(s, c?.type)
              const sel = s.id === selectedId
              const d = s.points.map(([x, y], k) => `${k ? 'L' : 'M'}${sx(x).toFixed(2)} ${sy(y).toFixed(2)}`).join(' ') + (s.closed ? ' Z' : '')
              return (
                <path
                  key={i}
                  d={d}
                  fill={st.fill}
                  stroke={sel ? 'var(--or-fig-select)' : st.stroke}
                  strokeWidth={sel ? 2.4 : 1.3}
                  strokeDasharray={st.dash}
                  strokeLinejoin="round"
                />
              )
            })}
            {a && showCgCp && Number.isFinite(a.cg.x) && (
              <CgMarker x={sx(a.cg.x)} y={sy(0)} r={6.5} />
            )}
            {a && showCgCp && a.cp.cna > 0 && Number.isFinite(a.cp.x) && <CpMarker x={sx(a.cp.x)} y={sy(0)} r={6.5} />}
          </svg>

          {/* RocketInfo: main info, top-left */}
          {a && (
            <div className="orw-overlay" style={{ left: 8, top: 4 }} title={provenance}>
              <div>{doc.rocket.name}</div>
              <div>
                Length {fmt2(a.length)}, max. diameter {fmt2(a.maxDiameter)}
              </div>
              <div>Mass with no motors {mass(a.cgEmpty.mass)}</div>
              {hasMotors && <div>Mass with motors {mass(a.cg.mass)}</div>}
            </div>
          )}
          {/* stability, top-right */}
          {a && (
            <div className="orw-overlay" style={{ right: 6, top: 4, textAlign: 'right', pointerEvents: 'auto' }} title={provenance} data-testid="stability">
              <div>
                Stability:{' '}
                {Number.isFinite(a.stability.calibers)
                  ? `${fmtSig(a.stability.calibers, 2)} cal / ${fmtSig(a.stability.percent, 3)} %`
                  : 'N/A'}
              </div>
              <div>
                {showCgCp && <CgGlyph size={11} />} CG: {L(a.cg.x)}
              </div>
              <div>
                {showCgCp && <CpGlyph size={11} />} CP: {a.cp.cna > 0 ? L(a.cp.x) : 'N/A'}
              </div>
              <div style={{ color: '#b2b2b2', fontSize: 10, marginTop: -1 }}>
                at M={a.conditions.mach.toFixed(3)}
                {a.conditions.aoaDeg !== 0 ? ` α=${fmtNumber(a.conditions.aoaDeg, 1)}°` : ''}
                {a.conditions.theta !== 0 ? ` θ=${fmtNumber((a.conditions.theta * 180) / Math.PI, 0)}°` : ''}
              </div>
            </div>
          )}
          {/* flight data, bottom-left (no simulations yet: N/A, as OpenRocket shows before a run) */}
          <div className="orw-overlay" style={{ left: 8, bottom: 4, color: 'var(--or-navy)', fontSize: 11 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', columnGap: 8 }}>
              <span>Flight configuration:</span>
              <span>{configLabel}</span>
              <span>Apogee:</span>
              <span>N/A</span>
              <span>Max. velocity:</span>
              <span>N/A</span>
              <span>Max. acceleration:</span>
              <span>N/A</span>
            </div>
          </div>
          {/* warnings, bottom-right */}
          {a && showWarnings && a.warnings.length > 0 && (
            <div className="orw-overlay" style={{ right: 6, bottom: 4, color: '#c80000', textAlign: 'right', fontSize: 11 }}>
              <div style={{ fontWeight: 600 }}>{a.warnings.length === 1 ? 'Warning:' : `${a.warnings.length} warning(s)`}</div>
              {a.warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function fitPercent(analysis: Analysis | null, w: number, h: number): number {
  if (!analysis) return 100
  const b = analysis.figure.bounds
  const W = w - RULER
  const H = h - RULER
  const s = Math.min((W - 2 * MARGIN_X) / Math.max(1e-6, b.xmax - b.xmin), (H - 2 * MARGIN_Y) / Math.max(1e-6, b.ymax - b.ymin))
  return (100 * s) / PX_PER_M_AT_100
}
