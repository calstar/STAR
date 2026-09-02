/**
 * Motor search over the offline thrustcurve.org mirror (GET /api/motors).
 *
 * The Full (RockSim) vs Basic (RASP) datafile distinction is hidden from the UI for now --
 * it confuses more than it helps, since both formats carry a full thrust curve. Picking a row
 * selects the motor (defaulting to a RockSim datafile when one exists); the parent folds it
 * into the CG / static margin.
 */

import { useEffect, useRef, useState } from 'react'
import { btn, useDisabled } from '@stardesign-ui'

import { searchMotors } from '../../api/client'
import type { MotorSimfileRef, MotorSummary } from '../../types'

interface Props {
  onSelect: (motor: MotorSummary, simfileId: string) => void
  onClose: () => void
}

/** Prefer a RockSim datafile (richer in principle); fall back to the first available. */
function defaultSimfile(motor: MotorSummary): MotorSimfileRef | undefined {
  return motor.simfiles.find((s) => s.format === 'RockSim') ?? motor.simfiles[0]
}

/** Motor impulse classes, small to large; used for the filter chips. */
const IMPULSE_CLASSES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O']
const RESULT_LIMIT = 80

/** Shared column template so the header and every row line up. Name and manufacturer both flex
 *  (and truncate) so the name doesn't hog the width; size is fixed. The header lives inside the
 *  same scroll container as the rows, so the scrollbar narrows both equally. */
const ROW_GRID = 'grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_5rem] items-center gap-2'

export function MotorPicker({ onSelect, onClose }: Props) {
  // Picking a motor writes cad.motor. The buttons that open this picker are
  // already gated, but reachability is not gating -- if the checkout lapses
  // while the list is open, the rows have to go dead too.
  const readOnly = useDisabled()
  const [query, setQuery] = useState('')
  const [impulseClass, setImpulseClass] = useState('')
  const [items, setItems] = useState<MotorSummary[]>([])
  const [total, setTotal] = useState(0)
  const [busy, setBusy] = useState(false)
  const [available, setAvailable] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Debounced search; an empty query returns the catalog (optionally filtered to
  // one impulse class), sorted small-to-large so browsing spans A..O.
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setBusy(true)
      setError(null)
      searchMotors(query, { limit: RESULT_LIMIT, impulseClass, signal: controller.signal })
        .then((res) => {
          setItems(res.items)
          setTotal(res.total)
          setAvailable(res.available)
        })
        .catch((exc) => {
          if (!controller.signal.aborted) setError(String(exc))
        })
        .finally(() => setBusy(false))
    }, 200)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [query, impulseClass])

  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2">
      <div className="mb-2 flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search motors (e.g. Estes C6, AeroTech H128)…"
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-1 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
        />
        <button
          type="button"
          onClick={onClose}
          className={`${btn}`}
        >
          Close
        </button>
      </div>

      {/* Impulse-class filter: the catalog has A..O; the chips make the bigger
          classes reachable without knowing a motor's exact name. */}
      <div className="mb-2 flex flex-wrap gap-1">
        <button
          type="button"
          onClick={() => setImpulseClass('')}
          className={`rounded px-1.5 py-0.5 text-2xs font-medium ${
            impulseClass === '' ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-border)]'
          }`}
        >
          All
        </button>
        {IMPULSE_CLASSES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setImpulseClass((cur) => (cur === c ? '' : c))}
            className={`w-6 rounded px-1 py-0.5 text-2xs font-medium ${
              impulseClass === c ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-border)]'
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      {!available && (
        <p className="px-1 py-2 text-xs text-amber-300">
          Motor catalog not fetched yet. Run{' '}
          <code className="rounded bg-[var(--color-bg-tertiary)] px-1">python -m backend.motors.fetch</code>.
        </p>
      )}
      {error && <p className="px-1 py-2 text-xs text-rose-400">{error}</p>}
      {available && !error && (
        <p className="px-1 pb-1 text-2xs text-[var(--color-text-muted)]">
          {busy
            ? 'Searching…'
            : total > items.length
              ? `Showing ${items.length} of ${total} — refine your search or pick a class.`
              : `${total} motor${total === 1 ? '' : 's'}`}
        </p>
      )}

      {/* Header + rows share one scroll container so the scrollbar narrows both equally and
          the columns stay aligned; the header is sticky so it stays visible while scrolling. */}
      <div className="max-h-64 overflow-y-auto">
        <div
          className={`${ROW_GRID} sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 pb-1 pt-0.5 text-2xs uppercase tracking-wide text-[var(--color-text-muted)]`}
        >
          <span>Motor</span>
          <span>Mfr</span>
          <span>Size</span>
        </div>

        <ul>
        {items.map((motor) => {
          const def = defaultSimfile(motor)
          return (
            <li key={motor.motorId}>
              <button
                type="button"
                disabled={!def || readOnly}
                onClick={() => def && onSelect(motor, def.simfileId)}
                className={`${ROW_GRID} w-full rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--color-bg-tertiary)] disabled:opacity-40`}
              >
                <span className="truncate font-mono text-[var(--color-accent)]" title={motor.designation}>
                  {motor.designation}
                </span>
                <span className="truncate text-[var(--color-text-muted)]" title={motor.manufacturerAbbrev}>
                  {motor.manufacturerAbbrev}
                </span>
                <span className="whitespace-nowrap text-[var(--color-text-muted)]">
                  {motor.diameter}×{motor.length}mm
                </span>
              </button>
            </li>
          )
        })}
        {!busy && items.length === 0 && available && !error && (
          <li className="px-2 py-2 text-xs text-[var(--color-text-muted)]">No motors match.</li>
        )}
        </ul>
      </div>
    </div>
  )
}
