/**
 * The rows OpenRocket's *Config panels are built from, bound to one
 * component's params through EditCtx.
 */
import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { Analysis, AxialMethod, Component, MaterialDb, MaterialType, ParamValue, Params, RocketDocument } from '../../types'
import { Check, Combo, Group, Spinner } from '../swing'
import { auto, isAuto, material, num, pos, str } from '../../lib/params'
import { AXIAL_METHODS, convertMethod, type PositionContext } from '../../lib/position'
import { findParent } from '../../lib/tree'
import { densityKind, type Kind } from '../../lib/units'
import { useUnits } from '../../workbench/units'

export interface EditCtxValue {
  c: Component
  doc: RocketDocument
  analysis: Analysis | null
  materials: MaterialDb | null
  /** Set one param (undefined deletes). Coalesced per key into one undo step. */
  set: (key: string, value: ParamValue | undefined) => void
  /** Replace several params at once. */
  setParams: (fn: (p: Params) => Params, key: string) => void
  /** Proposed extension: the analysis's resolved value for an auto param. */
  resolved: (key: string) => number | undefined
}

export const EditCtx = createContext<EditCtxValue | null>(null)

export function useEdit(): EditCtxValue {
  const v = useContext(EditCtx)
  if (!v) throw new Error('useEdit outside EditCtx')
  return v
}

/** Label column + control column, rows 35 px apart as in OpenRocket. */
export function Rows({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'max-content max-content', columnGap: 8, rowGap: 6, alignItems: 'center', ...style }}>
      {children}
    </div>
  )
}

export function Row({ label, children, sub }: { label?: ReactNode; children: ReactNode; sub?: ReactNode }) {
  return (
    <>
      <span style={{ alignSelf: 'start', lineHeight: '23px', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
        {children}
        {sub}
      </span>
    </>
  )
}

export function Spacer() {
  return (
    <>
      <span style={{ height: 6 }} />
      <span />
    </>
  )
}

export function NumField({
  k, kind = 'length', min = 0, max = Infinity, slider, scale = 1, fallback = 0, disabled, width,
}: {
  k: string
  kind?: Kind
  min?: number
  max?: number
  slider?: [number, number] | null
  scale?: number
  fallback?: number
  disabled?: boolean
  width?: number
}) {
  const e = useEdit()
  const p = e.c.params
  const raw = p[k]
  const isA = isAuto(raw) && raw.auto
  const value = isA ? (e.resolved(k) ?? auto(p, k, fallback).value) : num(p, k, fallback)
  const sl = slider === null ? undefined : (slider ?? defaultSlider(kind, value))
  return (
    <Spinner
      value={value}
      kind={kind}
      min={min}
      max={max}
      scale={scale}
      disabled={disabled}
      width={width}
      slider={sl ? [sl[0], Math.max(sl[1], value * 1.05)] : undefined}
      onChange={(v) => e.set(k, isAuto(raw) ? { auto: false, value: v } : v)}
      ariaLabel={k}
    />
  )
}

function defaultSlider(kind: Kind, v: number): [number, number] {
  switch (kind) {
    case 'length':
      return [0, Math.max(0.2, v * 2)]
    case 'angle':
      return [-Math.PI / 2, Math.PI / 2]
    case 'mass':
      return [0, Math.max(0.1, v * 2)]
    default:
      return [0, Math.max(1, v * 2)]
  }
}

/** An "Automatic" check box under an auto-capable number. */
export function AutoCheck({ k, label = 'Automatic', fallback = 0 }: { k: string; label?: string; fallback?: number }) {
  const e = useEdit()
  const a = auto(e.c.params, k, fallback)
  return (
    <Check
      label={label}
      checked={a.auto}
      onChange={(on) => e.set(k, { auto: on, value: e.resolved(k) ?? a.value })}
    />
  )
}

export function CheckField({ k, label, title }: { k: string; label: ReactNode; title?: string }) {
  const e = useEdit()
  return <Check label={label} title={title} checked={e.c.params[k] === true} onChange={(v) => e.set(k, v)} />
}

export function ComboField<T extends string>({ k, options, fallback, width = 206 }: {
  k: string
  options: { value: T; label: string }[]
  fallback: T
  width?: number
}) {
  const e = useEdit()
  return <Combo value={(str(e.c.params, k, fallback) || fallback) as T} options={options} style={{ width }} onChange={(v) => e.set(k, v)} />
}

/** Material + finish group (MaterialPanel). */
export function MaterialGroup({ k = 'material', type = 'bulk', finish = true, title = 'Material', label = 'Component material:' }: {
  k?: string
  type?: MaterialType
  finish?: boolean
  title?: string
  label?: string
}) {
  return (
    <Group title={title} style={{ padding: '6px 8px 12px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {label && <span style={{ marginTop: 4 }}>{label}</span>}
        <MaterialCombo k={k} type={type} />
        {finish && (
          <>
            <span style={{ marginTop: 10 }}>Component finish:</span>
            <span style={{ display: 'flex', gap: 6 }}>
              <ComboField k="finish" fallback="normal" width={254} options={FINISHES} />
              <button type="button" className="orw-btn" disabled title="Applies to every external component in OpenRocket; not in this milestone">
                Set for all
              </button>
            </span>
          </>
        )}
      </div>
    </Group>
  )
}

export function MaterialCombo({ k, type, width = 348 }: { k: string; type: MaterialType; width?: number }) {
  const e = useEdit()
  const u = useUnits()
  const cur = material(e.c.params, k)
  const list = e.materials?.[type] ?? []
  const all = cur && !list.some((m) => m.name === cur.name) ? [{ name: cur.name, density: cur.density }, ...list] : list
  const label = (m: { name: string; density: number }) => `${m.name} (${u.fmt(densityKind(type), m.density)})`
  return (
    <select
      className="orw-field"
      style={{ width }}
      value={cur?.name ?? ''}
      aria-label={k}
      onChange={(ev) => {
        const m = all.find((x) => x.name === ev.target.value)
        if (m) e.set(k, { type, name: m.name, density: m.density })
      }}
    >
      {!cur && <option value="">(none)</option>}
      {all.map((m) => (
        <option key={m.name} value={m.name}>
          {label(m)}
        </option>
      ))}
    </select>
  )
}

// ExternalComponent.Finish, with their roughness as OpenRocket labels them.
export const FINISHES = [
  { value: 'rough', label: 'Rough (500 µm)' },
  { value: 'roughunfinished', label: 'Rough unfinished (250 µm)' },
  { value: 'unfinished', label: 'Unfinished (150 µm)' },
  { value: 'normal', label: 'Regular paint (60 µm)' },
  { value: 'smooth', label: 'Smooth paint (20 µm)' },
  { value: 'optimum', label: 'Optimum paint (5 µm)' },
  { value: 'polished', label: 'Aircraft sheet-metal (2 µm)' },
  { value: 'finishpolished', label: 'Finished/polished surface (2 µm)' },
  { value: 'mirror', label: 'Mirror surface (0 µm)' },
]

/** Where the component sits, for converting offsets between methods. */
export function usePositionContext(): PositionContext {
  const e = useEdit()
  const a = e.analysis
  const parent = findParent(e.doc.rocket, e.c.id)
  const row = (id: string | undefined) => (id ? a?.components.find((r) => r.id === id) : undefined)
  const me = row(e.c.id)
  const pr = row(parent?.id)
  let prevEnd = 0
  if (parent && pr) {
    const i = parent.children.findIndex((ch) => ch.id === e.c.id)
    const prev = i > 0 ? row(parent.children[i - 1].id) : undefined
    if (prev) prevEnd = prev.x + prev.length - pr.x
  }
  return {
    length: me?.length ?? 0,
    parentLength: pr?.length ?? 0,
    parentX: pr?.x ?? 0,
    prevEnd,
  }
}

/** "Position relative to: [method]  plus [offset]" (PlacementPanel). */
export function PositionRows({ fallback = 'top', methods }: { fallback?: AxialMethod; methods?: AxialMethod[] }) {
  const e = useEdit()
  const ctx = usePositionContext()
  const p = pos(e.c.params, 'axialoffset', fallback)
  const opts = AXIAL_METHODS.filter((m) => (methods ?? ['top', 'middle', 'bottom', 'absolute']).includes(m.value))
  return (
    <>
      <Row label="Position relative to:">
        <Combo
          value={p.method}
          options={opts}
          style={{ width: 238 }}
          onChange={(m) => e.set('axialoffset', convertMethod(p, m, ctx))}
        />
      </Row>
      <Row label={<span style={{ display: 'block', textAlign: 'right' }}>plus</span>}>
        <Spinner
          value={p.value}
          kind="length"
          slider={[-Math.max(0.1, ctx.parentLength), Math.max(0.1, ctx.parentLength)]}
          onChange={(v) => e.set('axialoffset', { method: p.method, value: v })}
          ariaLabel="axialoffset"
        />
      </Row>
    </>
  )
}

export function PlacementGroup({ children, fallback, methods }: { children?: ReactNode; fallback?: AxialMethod; methods?: AxialMethod[] }) {
  return (
    <Group title="Placement" style={{ padding: '6px 8px 12px' }}>
      <Rows style={{ marginTop: 4 }}>
        <PositionRows fallback={fallback} methods={methods} />
        {children}
      </Rows>
    </Group>
  )
}
