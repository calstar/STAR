/**
 * Swing-alike primitives: the handful of widgets every OpenRocket dialog is
 * made of (button, spinner + unit + slider, combo, check box, titled group,
 * tabbed pane, dialog window). Styled by workbench/openrocket.css.
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useModalFocus } from '@stardesign-ui'
import { useUnits } from '../workbench/units'
import { LENGTH_UNITS, MASS_UNITS, fmtSig, type Kind } from '../lib/units'
import { pix } from '../workbench/icons'

export function Btn({
  children, icon, onClick, disabled, title, className = '', style, isDefault,
}: {
  children?: ReactNode
  icon?: string
  onClick?: () => void
  disabled?: boolean
  title?: string
  className?: string
  style?: CSSProperties
  isDefault?: boolean
}) {
  return (
    <button
      type="button"
      className={`orw-btn ${isDefault ? 'default' : ''} ${className}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={style}
    >
      {icon && <img src={pix(icon)} alt="" />}
      {children}
    </button>
  )
}

export function Check({
  label, checked, onChange, disabled, title,
}: {
  label: ReactNode
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  title?: string
}) {
  return (
    <label className={`orw-check ${disabled ? 'dis' : ''}`} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

/** A JRadioButton; group them by giving the same `name`. */
export function Radio({
  label, checked, onChange, disabled, name,
}: {
  label: ReactNode
  checked: boolean
  onChange: () => void
  disabled?: boolean
  name: string
}) {
  return (
    <label className={`orw-check orw-radio ${disabled ? 'dis' : ''}`}>
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={() => onChange()} />
      {label}
    </label>
  )
}

export function Combo<T extends string>({
  value, options, onChange, disabled, style, className = '', title,
}: {
  value: T
  options: { value: T; label: string; disabled?: boolean }[]
  onChange: (v: T) => void
  disabled?: boolean
  style?: CSSProperties
  className?: string
  title?: string
}) {
  return (
    <select
      className={`orw-field ${className}`}
      value={value}
      disabled={disabled}
      style={style}
      title={title}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Group({ title, children, className = '', style, bold }: {
  title: ReactNode
  children: ReactNode
  className?: string
  style?: CSSProperties
  bold?: boolean
}) {
  return (
    <fieldset className={`orw-group ${bold ? 'bold' : ''} ${className}`} style={style}>
      <legend>{title}</legend>
      {children}
    </fieldset>
  )
}

export function Tabs<T extends string>({
  tabs, active, onChange, className = '', style,
}: {
  tabs: { id: T; label: string; disabled?: boolean; title?: string }[]
  active: T
  onChange: (t: T) => void
  className?: string
  style?: CSSProperties
}) {
  return (
    <div className={`orw-tabs ${className}`} role="tablist" style={style}>
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tab"
          aria-selected={t.id === active}
          aria-disabled={t.disabled}
          title={t.title}
          className={`orw-tab ${t.id === active ? 'active' : ''} ${t.disabled ? 'dis' : ''}`}
          onClick={() => !t.disabled && onChange(t.id)}
        >
          {t.label}
        </div>
      ))}
    </div>
  )
}

/**
 * The OpenRocket number row: [spinner][unit][slider]. SI in, SI out; the
 * unit box opens the unit menu (as OpenRocket's does) and changes the
 * preference for that kind everywhere.
 */
export function Spinner({
  value, onChange, kind = 'none', min = -Infinity, max = Infinity, step, disabled, width = 64,
  slider, sliderWidth = 80, scale = 1, title, ariaLabel,
}: {
  value: number
  onChange: (si: number) => void
  kind?: Kind
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  width?: number
  /** [lo, hi] in SI for the slider; omitted hides it. */
  slider?: [number, number]
  sliderWidth?: number
  /** Shown value = SI * scale (diameters from radii). */
  scale?: number
  title?: string
  ariaLabel?: string
}) {
  const u = useUnits()
  const shownOf = (si: number) => u.toDisplay(kind, si * scale)
  // OpenRocket's spinners show three significant figures (40.3°, 5.08 cm).
  const format = (si: number) => fmtSig(shownOf(si), 3)
  const dirty = useRef(false)
  const [text, setText] = useState(() => format(value))
  const [focused, setFocused] = useState(false)
  const [invalid, setInvalid] = useState(false)
  useEffect(() => {
    if (!focused) {
      setText(format(value))
      setInvalid(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused, u.prefs, scale, kind])

  const commit = (raw: string) => {
    const n = Number(raw.replace(',', '.'))
    if (raw.trim() === '' || !Number.isFinite(n)) {
      setInvalid(true)
      return
    }
    const si = u.fromDisplay(kind, n) / scale
    if (si < min - 1e-12 || si > max + 1e-12) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    onChange(si)
  }
  const bump = (dir: 1 | -1) => {
    if (disabled) return
    const shown = shownOf(value)
    const st = step ?? defaultStep(kind, u.label(kind))
    const next = Math.round((shown + dir * st) / st) * st
    const si = Math.min(max, Math.max(min, u.fromDisplay(kind, next) / scale))
    onChange(si)
  }
  const fill = slider ? Math.max(0, Math.min(100, ((value - slider[0]) / (slider[1] - slider[0])) * 100)) : 0
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }} title={title}>
      <span className={`orw-spin ${disabled ? 'dis' : ''}`} style={{ width }} aria-invalid={invalid || undefined}>
        <input
          aria-label={ariaLabel}
          value={text}
          disabled={disabled}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            // Only a typed value is committed: the shown one is rounded.
            if (dirty.current) commit(text)
            dirty.current = false
          }}
          onChange={(e) => {
            dirty.current = true
            setText(e.target.value)
            const n = Number(e.target.value.replace(',', '.'))
            if (e.target.value.trim() !== '' && Number.isFinite(n)) commit(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit(text)
              dirty.current = false
            }
            if (e.key === 'ArrowUp') { e.preventDefault(); bump(1) }
            if (e.key === 'ArrowDown') { e.preventDefault(); bump(-1) }
          }}
        />
        <span className="arrows" aria-hidden>
          <span onMouseDown={(e) => { e.preventDefault(); bump(1) }}>
            <svg width="9" height="5"><path d="M.5 4.5l4-4 4 4" fill="none" stroke="#666" /></svg>
          </span>
          <span onMouseDown={(e) => { e.preventDefault(); bump(-1) }}>
            <svg width="9" height="5"><path d="M.5.5l4 4 4-4" fill="none" stroke="#666" /></svg>
          </span>
        </span>
      </span>
      {kind !== 'none' ? <UnitBox kind={kind} disabled={disabled} /> : slider ? <span style={{ width: 40 }} /> : null}
      {slider && (
        <input
          type="range"
          className="orw-slider"
          style={{ width: sliderWidth, marginLeft: 16, ['--fill' as string]: `${fill}%` }}
          min={0}
          max={1000}
          value={Math.round(fill * 10)}
          disabled={disabled}
          aria-label={ariaLabel ? `${ariaLabel} slider` : undefined}
          onChange={(e) => onChange(slider[0] + (Number(e.target.value) / 1000) * (slider[1] - slider[0]))}
        />
      )}
    </span>
  )
}

function defaultStep(kind: Kind, label: string): number {
  if (kind === 'angle') return 1
  if (kind === 'length') return label === 'mm' ? 1 : label === 'cm' ? 0.1 : label === 'm' ? 0.001 : label === 'in' ? 0.05 : 0.01
  if (kind === 'mass') return label === 'g' ? 1 : label === 'kg' ? 0.001 : label === 'oz' ? 0.1 : 0.01
  if (kind === 'none') return 0.1
  return 0.1
}

/** The grey unit box; for length and mass, a click offers the units. */
export function UnitBox({ kind, disabled }: { kind: Kind; disabled?: boolean }) {
  const u = useUnits()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const choices = kind === 'length' ? LENGTH_UNITS : kind === 'mass' ? MASS_UNITS : null
  return (
    <span
      ref={ref}
      className={`orw-unit ${choices ? 'clickable' : ''} ${disabled ? 'dis' : ''}`}
      style={{ position: 'relative' }}
      onClick={() => choices && setOpen((o) => !o)}
    >
      {u.label(kind)}
      {open && choices && (
        <div className="orw-popup" style={{ top: 22, left: 0, minWidth: 70 }}>
          {choices.map((c) => (
            <div
              key={c}
              className={`orw-mi ${u.label(kind) === c ? 'hot' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                u.setPrefs(kind === 'length' ? { ...u.prefs, length: c as typeof u.prefs.length } : { ...u.prefs, mass: c as typeof u.prefs.mass })
                setOpen(false)
              }}
            >
              {c}
            </div>
          ))}
        </div>
      )}
    </span>
  )
}

/**
 * A floating dialog window (JDialog). Non-modal, as OpenRocket's component
 * dialog is; drag by the thin title strip. Focus and Escape via the shared
 * stardesign-ui hook.
 */
export function Window({
  title, children, onClose, initial, width, modal, zIndex,
}: {
  title: string
  children: ReactNode
  onClose: () => void
  initial: { x: number; y: number }
  width: number
  modal?: boolean
  zIndex?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState(initial)
  const id = useId()
  useModalFocus(ref, true, onClose)
  const startDrag = (e: React.MouseEvent) => {
    const sx = e.clientX - at.x
    const sy = e.clientY - at.y
    const move = (ev: MouseEvent) => setAt({ x: ev.clientX - sx, y: Math.max(0, ev.clientY - sy) })
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  const box = (
    <div
      ref={ref}
      role="dialog"
      aria-modal={modal ? 'true' : 'false'}
      aria-labelledby={id}
      tabIndex={-1}
      className="orw-dialog"
      style={{ left: at.x, top: at.y, width, zIndex }}
    >
      <div className="titlebar" onMouseDown={startDrag}>
        <span id={id}>{title}</span>
        <span className="x" onClick={onClose} onMouseDown={(e) => e.stopPropagation()} aria-label="Close" role="button">
          ✕
        </span>
      </div>
      {children}
    </div>
  )
  if (!modal) return box
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: (zIndex ?? 40) - 1, background: 'rgba(0,0,0,0.08)' }}>
      {box}
    </div>
  )
}

/** A vertical JSlider (the figure's roll rotation): thin track, round knob, 0 at the top. */
export function VSlider({ value, min, max, onChange, ariaLabel, style }: {
  value: number
  min: number
  max: number
  onChange: (v: number) => void
  ariaLabel?: string
  style?: CSSProperties
}) {
  const track = useRef<HTMLDivElement>(null)
  const frac = (value - min) / (max - min || 1)
  const at = (clientY: number) => {
    const r = track.current!.getBoundingClientRect()
    const f = Math.max(0, Math.min(1, (clientY - r.top) / r.height))
    onChange(min + f * (max - min))
  }
  return (
    <div
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-orientation="vertical"
      tabIndex={0}
      style={{ position: 'relative', width: 16, cursor: 'default', ...style }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') onChange(Math.min(max, value + (max - min) / 72))
        if (e.key === 'ArrowUp') onChange(Math.max(min, value - (max - min) / 72))
      }}
      onMouseDown={(e) => {
        at(e.clientY)
        const mv = (m: MouseEvent) => at(m.clientY)
        const up = () => {
          window.removeEventListener('mousemove', mv)
          window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', mv)
        window.addEventListener('mouseup', up)
      }}
    >
      <div ref={track} style={{ position: 'absolute', left: 6, width: 4, top: 6, bottom: 6, borderRadius: 2, background: 'var(--or-slider-track)' }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: `${frac * 100}%`, borderRadius: 2, background: 'var(--or-slider)' }} />
      </div>
      <div style={{ position: 'absolute', left: 2, top: `calc(${frac} * (100% - 12px))`, width: 12, height: 12, borderRadius: 6, background: 'var(--or-slider)' }} />
    </div>
  )
}
