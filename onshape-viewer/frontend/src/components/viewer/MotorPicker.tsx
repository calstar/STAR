/**
 * Motor search over the offline thrustcurve.org mirror (GET /api/motors).
 *
 * Each result lists its datafiles as "Full model" (RockSim) or "Basic model"
 * (RASP). The label is by file format, per the product decision: the API serves
 * both with mid-casing CG, so that is the distinction the user actually chooses
 * between. Picking a row selects the motor (defaulting to a Full datafile when one
 * exists); the parent folds it into the CG / static margin.
 */

import { useEffect, useRef, useState } from 'react'

import { searchMotors } from '../../api/client'
import type { MotorSimfileRef, MotorSummary } from '../../types'

interface Props {
  onSelect: (motor: MotorSummary, simfileId: string) => void
  onClose: () => void
}

/** RockSim files are the "Full model"; RASP are "Basic". */
function tierLabel(format: MotorSimfileRef['format']): string {
  return format === 'RockSim' ? 'Full' : 'Basic'
}

/** Prefer a Full (RockSim) datafile; fall back to the first available. */
function defaultSimfile(motor: MotorSummary): MotorSimfileRef | undefined {
  return motor.simfiles.find((s) => s.format === 'RockSim') ?? motor.simfiles[0]
}

export function MotorPicker({ onSelect, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<MotorSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [available, setAvailable] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Debounced search; an empty query returns the first slice of the catalog.
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setBusy(true)
      setError(null)
      searchMotors(query, { limit: 40, signal: controller.signal })
        .then((res) => {
          setItems(res.items)
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
  }, [query])

  return (
    <div className="rounded border border-slate-700 bg-slate-900 p-2">
      <div className="mb-2 flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search motors (e.g. Estes C6, AeroTech H128)…"
          className="w-full rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={onClose}
          className="rounded bg-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-600"
        >
          Close
        </button>
      </div>

      {!available && (
        <p className="px-1 py-2 text-xs text-amber-300">
          Motor catalog not fetched yet. Run{' '}
          <code className="rounded bg-slate-800 px-1">python -m backend.motors.fetch</code>.
        </p>
      )}
      {error && <p className="px-1 py-2 text-xs text-rose-400">{error}</p>}
      {busy && <p className="px-1 py-1 text-xs text-slate-400">Searching…</p>}

      <ul className="max-h-64 overflow-y-auto">
        {items.map((motor) => {
          const def = defaultSimfile(motor)
          return (
            <li key={motor.motorId}>
              <button
                type="button"
                disabled={!def}
                onClick={() => def && onSelect(motor, def.simfileId)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-slate-800 disabled:opacity-40"
              >
                <span className="w-14 shrink-0 font-mono text-cyan-300">{motor.designation}</span>
                <span className="w-20 shrink-0 truncate text-slate-400">
                  {motor.manufacturerAbbrev}
                </span>
                <span className="shrink-0 text-slate-500">
                  {motor.diameter}×{motor.length}mm
                </span>
                <span className="ml-auto flex shrink-0 gap-1">
                  {motor.simfiles.map((s, i) => (
                    <span
                      key={`${s.simfileId}-${i}`}
                      className={`rounded px-1 py-0.5 text-[10px] font-medium ${
                        s.format === 'RockSim'
                          ? 'bg-emerald-900 text-emerald-300'
                          : 'bg-slate-700 text-slate-300'
                      }`}
                      title={s.format}
                    >
                      {tierLabel(s.format)}
                    </span>
                  ))}
                </span>
              </button>
            </li>
          )
        })}
        {!busy && items.length === 0 && available && !error && (
          <li className="px-2 py-2 text-xs text-slate-500">No motors match.</li>
        )}
      </ul>
    </div>
  )
}
