/**
 * The chosen units, and the formatting helpers every render site calls.
 *
 * The app deliberately had no context before this (see App.tsx): one shared
 * config did not earn a provider when lifting it two levels was enough. A
 * preference read at ~90 render sites across four tabs does earn one --
 * threading it by prop would touch every component between the root and each
 * leaf, including ones that have nothing to do with units.
 *
 * What this must NOT do, and the reason it lives outside `UiConfig` entirely:
 * changing a unit must not re-run the simulation, and must not mark a finished
 * corner sweep as stale. Both of those key off `physicsKey(ui)`, so keeping
 * preferences unreachable from `ui` makes it structural rather than a list of
 * exclusions someone has to remember to extend. See `lib/serialise.physicsKey`.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react'
import type { ReactNode } from 'react'
import { getSettings, putSettings } from '../../recovery/api/client'
import {
  DEFAULT_PREFS, DEFAULT_PRECISION, KINDS, decimalsFor, formatForInput,
  fromDisplay, parsePrecision, parsePrefs, toDisplay, unitFor,
} from './quantities'
import type { Kind, Precision, System, UnitDef, UnitPrefs } from './quantities'

/** Seconds as m:ss when it is long enough for that to help. The plain-seconds
 *  branch takes its decimals from the caller so it follows the Units tab's
 *  precision bound; the m:ss branch is a clock format, with no decimals to bound.
 *  Local to the provider -- the `dur` helper below is its only consumer. */
function fmtDuration(s: number, digits = 1): string {
  if (!Number.isFinite(s)) return '-'
  if (s < 60) return `${s.toFixed(digits)} s`
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(0).padStart(2, '0')} (${s.toFixed(0)} s)`
}

/** Survives a reload when the backend is down, which is a state this app
 *  supports on every other route too. The server always wins when it answers;
 *  this is a cache, not a second source of truth. */
const MIRROR_KEY = 'recovery-calculator.units'

/** Long enough to collapse a burst of "All imperial" clicks into one write,
 *  short enough that the save lands before anyone reaches for the tab. */
const SAVE_DEBOUNCE_MS = 400

export type SaveState = 'idle' | 'saving' | 'saved' | 'offline'

export interface Units {
  prefs: UnitPrefs
  setKind: (kind: Kind, system: System) => void
  setAll: (system: System) => void
  /** How precise every number looks. Two bounds -- see `quantities.Precision`. */
  precision: Precision
  setPrecision: (p: Partial<Precision>) => void
  /** The chosen unit's full definition -- label, factor, digits, step. */
  u: (kind: Kind) => UnitDef
  /** Just the label: 'lbf'. */
  lab: (kind: Kind) => string
  /** SI -> the display number, unformatted. For chart data and axis domains,
   *  where a string would be wrong. */
  val: (si: number, kind: Kind) => number
  /** The display number as a string. `digits` is the FIELD's own precision,
   *  not an override -- both precision bounds still apply on top of it, which
   *  is what makes the setting global. */
  num: (si: number | null | undefined, kind: Kind, digits?: number) => string
  /** Number and label together: '363 lbf'. */
  q: (si: number | null | undefined, kind: Kind, digits?: number) => string
  /** The same policy for a number with no unit -- seconds, ratios, X1, A. */
  dec: (v: number | null | undefined, digits?: number) => string
  /** A descent time. m:ss past a minute; bounded seconds below it. */
  dur: (s: number) => string
  /** SI -> what an editable box should show: bounded, trailing zeros stripped. */
  forInput: (si: number, kind: Kind) => string
  /** The display number back to SI. The editable-input direction. */
  si: (shown: number, kind: Kind) => number
  save: SaveState
}

const UnitsContext = createContext<Units | null>(null)

interface Stored { units: UnitPrefs; precision: Precision }

function readMirror(): Stored {
  try {
    const raw = localStorage.getItem(MIRROR_KEY)
    const j = raw ? JSON.parse(raw) : null
    return {
      units: parsePrefs(j?.units),
      precision: parsePrecision(j?.precision),
    }
  } catch {
    // A quota error, private-browsing lockout or corrupt JSON must not stop
    // the app from opening. Defaults are always a valid answer here.
    return { units: DEFAULT_PREFS, precision: DEFAULT_PRECISION }
  }
}

function writeMirror(v: Stored) {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(v))
  } catch { /* see readMirror */ }
}

export function UnitsProvider({ children }: { children: ReactNode }) {
  // Start from the mirror rather than the defaults, so a reload does not flash
  // feet before settling on metres.
  const [stored, setStored] = useState<Stored>(readMirror)
  const { units: prefs, precision } = stored
  const [save, setSave] = useState<SaveState>('idle')

  /** Suppresses the save that would otherwise fire on the initial load --
   *  writing back exactly what we just read is pointless traffic, and it would
   *  create the file on disk for a user who never opened the Units tab. */
  const loaded = useRef(false)

  useEffect(() => {
    let alive = true
    getSettings().then((res) => {
      if (!alive) return
      if (res.data) {
        const server: Stored = {
          units: parsePrefs(res.data.units),
          precision: parsePrecision(res.data.precision),
        }
        setStored(server)
        writeMirror(server)
      } else {
        setSave('offline')
      }
      loaded.current = true
    })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!loaded.current) return
    writeMirror(stored)
    setSave('saving')
    const id = setTimeout(() => {
      void putSettings(stored.units, stored.precision).then((res) => {
        setSave(res.data ? 'saved' : 'offline')
      })
    }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [stored])

  const setKind = useCallback((kind: Kind, system: System) => {
    setStored((s) => (s.units[kind] === system
      ? s : { ...s, units: { ...s.units, [kind]: system } }))
  }, [])

  const setAll = useCallback((system: System) => {
    setStored((s) => ({
      ...s,
      units: Object.fromEntries(KINDS.map((k) => [k, system])) as UnitPrefs,
    }))
  }, [])

  const setPrecision = useCallback((p: Partial<Precision>) => {
    setStored((s) => ({ ...s, precision: { ...s.precision, ...p } }))
  }, [])

  const value = useMemo<Units>(() => {
    const u = (kind: Kind) => unitFor(kind, prefs)

    /** One renderer for every number on screen. `fieldDigits` is what the
     *  field would use on its own; both precision bounds apply on top of it,
     *  which is what makes the Units tab's setting global rather than a
     *  suggestion individual call sites can ignore. */
    const render = (v: number | null | undefined, fieldDigits: number) => {
      if (v === null || v === undefined || !Number.isFinite(v)) return '-'
      const dp = decimalsFor(v, fieldDigits, precision)
      // Thousands separators once the magnitude earns them: 27,263 N reads
      // badly next to 1,613 without.
      return Math.abs(v) >= 10000
        ? v.toLocaleString('en-US', {
            minimumFractionDigits: dp, maximumFractionDigits: dp })
        : v.toFixed(dp)
    }

    const num = (si: number | null | undefined, kind: Kind, digits?: number) => {
      if (si === null || si === undefined || !Number.isFinite(si)) return '-'
      const def = u(kind)
      return render(toDisplay(si, def), digits ?? def.digits)
    }

    return {
      prefs, setKind, setAll, precision, setPrecision, save, u,
      lab: (kind) => u(kind).label,
      val: (si, kind) => toDisplay(si, u(kind)),
      num,
      q: (si, kind, digits) => `${num(si, kind, digits)} ${u(kind).label}`,
      // An unset `digits` means "no natural precision of its own", so the
      // bounds are the only thing shaping it.
      dec: (v, digits) => render(v, digits ?? Infinity),
      dur: (s) => fmtDuration(s, decimalsFor(s, 1, precision)),
      forInput: (si, kind) => formatForInput(toDisplay(si, u(kind)), precision),
      si: (shown, kind) => fromDisplay(shown, u(kind)),
    }
  }, [prefs, precision, setKind, setAll, setPrecision, save])

  return <UnitsContext.Provider value={value}>{children}</UnitsContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useUnits(): Units {
  const ctx = useContext(UnitsContext)
  if (!ctx) throw new Error('useUnits must be used inside <UnitsProvider>')
  return ctx
}
