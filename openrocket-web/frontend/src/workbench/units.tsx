/**
 * The workbench's own units preference, persisted per browser. Deliberately
 * internal to <OpenRocketWorkbench/> so it mounts inside star-openrocket
 * without colliding with that app's UnitsProvider.
 */
import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { fmt, fromDisplay, parsePrefs, toDisplay, unitFor, type Kind, type UnitPrefs } from '../lib/units'
import { load, save } from '../lib/persist'

interface UnitsApi {
  prefs: UnitPrefs
  setPrefs: (p: UnitPrefs) => void
  fmt: (kind: Kind, si: number, digits?: number) => string
  toDisplay: (kind: Kind, si: number) => number
  fromDisplay: (kind: Kind, shown: number) => number
  label: (kind: Kind) => string
  digits: (kind: Kind) => number
}

const Ctx = createContext<UnitsApi | null>(null)

export function UnitsProvider({ children }: { children: ReactNode }) {
  const [prefs, setState] = useState<UnitPrefs>(() => parsePrefs(load('units', null)))
  const setPrefs = useCallback((p: UnitPrefs) => {
    setState(p)
    save('units', p)
  }, [])
  const value = useMemo<UnitsApi>(
    () => ({
      prefs,
      setPrefs,
      fmt: (k, si, d) => fmt(k, si, prefs, d),
      toDisplay: (k, si) => toDisplay(k, si, prefs),
      fromDisplay: (k, v) => fromDisplay(k, v, prefs),
      label: (k) => unitFor(k, prefs).label,
      digits: (k) => unitFor(k, prefs).digits,
    }),
    [prefs, setPrefs],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useUnits(): UnitsApi {
  const v = useContext(Ctx)
  if (!v) throw new Error('useUnits outside <UnitsProvider>')
  return v
}
