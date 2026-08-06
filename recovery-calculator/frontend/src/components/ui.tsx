/**
 * Shared primitives. Everything visual that appears more than once lives here,
 * so the two tabs cannot drift into two different-looking applications.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { Kind } from '../lib/quantities'
import { useUnits } from '../lib/unitsContext'

/**
 * The one-line header a tab opens on: what the page is, in a sentence. It is
 * its own block above the page's cards -- deliberately separate from any run
 * controls, so "what this page is" and "the button that runs it" do not share a
 * row. Every tab uses the same shape so they read as one application.
 */
export function PageHeader({ title, children }: {
  title: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1">
      <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">
        {title}
      </h1>
      {children && (
        <p className="font-prose text-sm text-[var(--color-text-secondary)]">
          {children}
        </p>
      )}
    </div>
  )
}

export function Card({ title, subtitle, right, children, className = '' }: {
  title?: ReactNode
  subtitle?: ReactNode
  right?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] ${className}`}>
      {(title || right) && (
        <header className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-4 py-3">
          <div className="min-w-0">
            {title && (
              <h2 className="text-base font-semibold text-[var(--color-text-primary)]">
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="font-prose mt-0.5 text-xs leading-relaxed text-[var(--color-text-secondary)]">
                {subtitle}
              </p>
            )}
          </div>
          {right && <div className="shrink-0">{right}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

/** `kind` is the normal way to label a field: it renders whatever unit the
 *  user has chosen for that quantity, and tracks it. `unit` is the escape
 *  hatch for the handful that are not configurable -- seconds, diameters. */
export function Field({ label, hint, unit, kind, children, wide = false }: {
  label: ReactNode
  hint?: ReactNode
  unit?: string
  kind?: Kind
  children: ReactNode
  wide?: boolean
}) {
  const { lab } = useUnits()
  const shown = kind ? lab(kind) : unit
  return (
    <label className={`flex flex-col gap-1 ${wide ? 'col-span-2' : ''}`}>
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-[var(--color-text-secondary)]">{label}</span>
        {shown && (
          <span className="text-2xs text-[var(--color-text-muted)]">{shown}</span>
        )}
      </span>
      {children}
      {hint && (
        <span className="font-prose text-xs leading-snug text-[var(--color-text-muted)]">
          {hint}
        </span>
      )}
    </label>
  )
}

const inputClass =
  'w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] '
  + 'px-2 py-1.5 text-sm text-[var(--color-text-primary)] outline-none '
  + 'focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]'

/**
 * `display` is the bounded, readable form of `value` -- see `UnitInput`. It is
 * shown only while the box is NOT focused; focusing reveals the full stored
 * number. Two reasons, both of them bugs otherwise:
 *
 *  1. Typing. Reformatting on every keystroke fights the caret -- type
 *     `12.3456` into a 2-decimal box and it rewrites to `12.35` mid-word.
 *  2. Stepping. Arrow keys step from the DISPLAYED value, so with the
 *     diameter box reading `0.10` for a stored `0.1016 m`, one arrow press
 *     would silently commit a 1.6% geometry change.
 *
 * Neither focus nor blur calls `onChange`. Formatting is a display event; if
 * it wrote back, `physicsKey(ui)` would move and the simulation would re-run
 * for a number that did not change.
 */
export function NumberInput({ value, display, onChange, step = 'any', min, max, placeholder, disabled }: {
  value: number | null
  display?: string
  onChange: (v: number | null) => void
  step?: number | 'any'
  min?: number
  max?: number
  placeholder?: string
  disabled?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const shown = display !== undefined && !editing ? display : (value ?? '')
  return (
    <input
      type="number"
      className={`${inputClass} font-num ${disabled ? 'opacity-50' : ''}`}
      value={shown}
      step={step}
      min={min}
      max={max}
      placeholder={placeholder}
      disabled={disabled}
      onFocus={() => setEditing(true)}
      onBlur={() => setEditing(false)}
      // Empty means "not supplied", which is a meaningful state in this schema
      // -- Optional[float] on T_pad, p_pad, k_eff and CdS_body all mean
      // "compute a default" rather than "zero".
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    />
  )
}

/**
 * A NumberInput that shows the user's chosen unit while storing SI.
 *
 * PLAN.md §1.1: units are SI internally, always -- convert at the I/O boundary
 * only. The form state IS the wire config (§11.7), so the conversion cannot
 * live in the state; it lives here, in the widget, and nothing downstream ever
 * sees a non-SI number.
 *
 * **It never calls `onChange` on a unit switch.** Changing a unit re-renders
 * this with a different divisor and that is all -- the stored value is not
 * touched, not re-snapped to the new unit's step, not round-tripped through
 * its display form. Writing back would change `physicsKey(ui)` and re-run the
 * simulation, or falsely mark a finished corner sweep as stale, for a number
 * that did not actually change. See `lib/serialise.physicsKey`.
 *
 * `step` comes from the registry rather than the call site, because it is in
 * DISPLAY units: `step={0.25}` for inches would silently become a quarter of a
 * metre the moment someone picked metric.
 */
export function UnitInput({ value, onChange, kind, step, min, disabled, placeholder }: {
  value: number | null
  onChange: (v: number | null) => void
  kind: Kind
  /** Overrides the registry's default granularity. Rarely needed. */
  step?: number | 'any'
  min?: number
  disabled?: boolean
  placeholder?: string
}) {
  const { u, val, si, forInput } = useUnits()
  return (
    <NumberInput
      value={value === null ? null : val(value, kind)}
      // Bounded by the Units tab's precision settings, so switching mass to kg
      // shows 5.67 rather than the exact 5.669904625 that 12.5 lb converts to.
      // Display only -- the stored value is untouched, and focusing the box
      // reveals it in full.
      display={value === null ? undefined : forInput(value, kind)}
      onChange={(v) => onChange(v === null ? null : si(v, kind))}
      step={step ?? u(kind).step}
      min={min}
      disabled={disabled}
      placeholder={placeholder}
    />
  )
}

export function TextInput({ value, onChange, placeholder }: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <input
      type="text"
      className={inputClass}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export function Select<T extends string>({ value, onChange, options }: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <select
      className={inputClass}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

/** A toggle chip. Used for the per-station series pickers, where the colour
 *  swatch has to match the line it controls or the legend is a lie. */
export function Chip({ active, onClick, colour, children, title, disabled }: {
  active: boolean
  onClick: () => void
  colour?: string
  children: ReactNode
  title?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors
        ${disabled ? 'cursor-not-allowed opacity-40' : ''}
        ${active
          ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]'
          : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'}`}
    >
      {colour && (
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: active ? colour : 'var(--color-text-muted)' }}
        />
      )}
      {children}
    </button>
  )
}

export function Toggle({ checked, onChange, label }: {
  checked: boolean
  onChange: (v: boolean) => void
  label: ReactNode
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-text-secondary)]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-[var(--color-accent)]"
      />
      {label}
    </label>
  )
}

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

const TONES: Record<BadgeTone, string> = {
  neutral: 'border-[var(--color-border)] text-[var(--color-text-secondary)]',
  accent: 'border-blue-500/40 bg-blue-500/10 text-blue-300',
  success: 'border-green-500/40 bg-green-500/10 text-green-300',
  warning: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  danger: 'border-red-500/40 bg-red-500/10 text-red-300',
}

export function Badge({ tone = 'neutral', children, title }: {
  tone?: BadgeTone
  children: ReactNode
  title?: string
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-2xs uppercase tracking-wide ${TONES[tone]}`}
    >
      {children}
    </span>
  )
}

/** As `Field`: `kind` for anything configurable, `unit` for the rest. The
 *  caller still formats `value` -- via `num(x, kind)`, which takes its
 *  precision from the same registry entry. */
export function Stat({ label, value, unit, kind, tone, hint }: {
  label: string
  value: ReactNode
  unit?: string
  kind?: Kind
  tone?: BadgeTone
  hint?: string
}) {
  const { lab } = useUnits()
  const shownUnit = kind ? lab(kind) : unit
  const colour = tone === 'danger' ? 'text-red-400'
    : tone === 'warning' ? 'text-amber-400'
    : tone === 'success' ? 'text-green-400'
    : 'text-[var(--color-text-primary)]'
  return (
    <div
      title={hint}
      // `h-full` + the grid's default row-stretch makes every box in a row take
      // the height of the tallest, so a two-line label no longer sits a box
      // taller than its neighbours. `mt-auto` on the value then pins every
      // number to the bottom edge, so the readouts line up across the row
      // regardless of how many lines each label wrapped to.
      className="flex h-full flex-col rounded border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3 py-2"
    >
      <div className="text-2xs uppercase tracking-wide text-[var(--color-text-muted)]">
        {label}
      </div>
      <div className={`font-num mt-auto pt-0.5 text-lg leading-tight ${colour}`}>
        {value}
        {shownUnit && (
          <span className="ml-1 text-xs text-[var(--color-text-secondary)]">
            {shownUnit}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * A read-only range with the nominal value marked.
 *
 * For quantities that are genuinely unknown rather than merely unentered --
 * PLAN.md's Cx and n, which §15.3/§15.4 record as never measured. A numeric
 * input would imply someone knows the value; this shows the band the corner
 * sweep actually covers and where the nominal run sits inside it.
 */
export function Band({ low, high, value, unit = '' }: {
  low: number
  high: number
  value: number
  unit?: string
}) {
  const span = high - low
  const pct = span > 0 ? Math.min(100, Math.max(0, ((value - low) / span) * 100)) : 50
  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3 py-2">
      <div className="font-num flex items-baseline justify-between text-xs text-[var(--color-text-secondary)]">
        <span>{low}{unit}</span>
        <span className="text-base text-[var(--color-text-primary)]">
          {value}{unit}
        </span>
        <span>{high}{unit}</span>
      </div>
      <div className="relative mt-1.5 h-1 rounded bg-[var(--color-border)]">
        <div
          className="absolute top-1/2 h-2.5 w-0.5 -translate-y-1/2 bg-[var(--color-text-primary)]"
          style={{ left: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export function Button({ onClick, children, variant = 'secondary', disabled, title }: {
  onClick: () => void
  children: ReactNode
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  disabled?: boolean
  title?: string
}) {
  const styles = {
    primary: 'bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] border-transparent',
    secondary: 'border-[var(--color-border)] text-[var(--color-text-primary)] hover:border-[var(--color-text-muted)]',
    ghost: 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
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

/**
 * A hoverable ⓘ. The rationale behind a control -- which failure it prevents,
 * which plan section demanded it -- is worth keeping, but not worth a
 * paragraph of body text next to every field. It lives in here instead.
 */
export function Info({ children }: { children: string }) {
  return (
    <span className="group relative ml-1 inline-flex align-middle">
      {/*
        A real tooltip, not a `title` attribute.

        `title` looked correct in the DOM and was useless in practice: it needs
        about a second of steady hover over a 10x13 px glyph, and it does
        nothing at all on click, so the natural reaction to a small ⓘ -- click
        it -- appeared broken. This gets a padded hit area, opens instantly on
        hover, and opens on keyboard focus too.
      */}
      <button
        type="button"
        aria-label="More information"
        className="cursor-help select-none rounded px-1 py-0.5 text-xs leading-none text-[var(--color-text-muted)] outline-none hover:text-[var(--color-text-primary)] focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
        // Clicking is a no-op by design; the handler exists so a tap on
        // touch devices fires focus and opens the panel.
        onClick={(e) => e.preventDefault()}
      >
        ⓘ
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-50 mt-1 w-72 rounded border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3 py-2 text-xs font-normal normal-case leading-relaxed tracking-normal text-[var(--color-text-secondary)] opacity-0 shadow-lg transition-opacity duration-75 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {children}
      </span>
    </span>
  )
}

/** Loud, unmissable banner for fixture-backed output. The one unacceptable
 *  outcome of shipping a stub is a reviewer mistaking it for a computed
 *  result, so this stays prominent even as the rest of the UI gets quieter. */
export function StubBanner({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded border border-amber-500/50 bg-amber-500/10 px-3 py-2">
      <span className="mt-0.5 text-amber-400">▲</span>
      <p className="font-prose text-xs leading-relaxed text-amber-200">{children}</p>
    </div>
  )
}

/** The Warnings card, rendered identically wherever warnings appear -- the
 *  Setup tab and the Cross-check tab share this one component so the two cannot
 *  drift. Renders nothing when there are no warnings. */
export function WarningsCard({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null
  return (
    <Card title="Warnings">
      <ul className="space-y-1.5">
        {warnings.map((w, i) => (
          <li
            key={i}
            className="flex gap-2 text-xs leading-relaxed text-amber-200/90"
          >
            <span className="shrink-0 text-amber-500">•</span>
            <span>{w}</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="font-prose flex h-full min-h-40 items-center justify-center rounded border border-dashed border-[var(--color-border)] px-6 text-center text-xs text-[var(--color-text-muted)]">
      {children}
    </div>
  )
}
