/**
 * The measured pad record, reduced to what a form needs.
 *
 * The climatology bundle is ~2 MB of soundings, monthly surface statistics and
 * ten years of ascents. Two places want a thin slice of it -- the Recovery
 * tab's Site form, which resolves the pad state a run uses, and the Sweep
 * tab's axis editor, which resolves the pad states a study compares -- and
 * both want the *same* slice, reduced the same way. Duplicating the reduction
 * is how the Setup tab and a study end up disagreeing about what January is.
 *
 * A hook rather than a context: `getClimatology` is a static bundle behind a
 * one-shot fetch, so two callers cost two fetches of an already-cached
 * response, and a provider would put the whole app inside a subscription for a
 * value that never changes after load.
 */

import { useEffect, useState } from 'react'
import { getClimatology } from '../api/client'
import type { PadSource } from '../types/schema'

/**
 * The four ways §11.3 offers of knowing the pad state, in the order the Site
 * form lists them.
 *
 * Here rather than beside that form because two components enumerate them now:
 * the form, which picks one for a run, and the Sweep tab's pad-state axis,
 * which compares several. Two lists of the same four options would drift, and
 * the one that drifted would be the one nobody was looking at.
 */
export const SOURCES: { value: PadSource; label: string }[] = [
  { value: 'isa', label: 'ISA standard column' },
  { value: 'barometer', label: 'Pad barometer — measured' },
  { value: 'metar', label: 'METAR — latest observation' },
  { value: 'climatology', label: 'Monthly normal — station record' },
]

/** Measured monthly lapse rates, K/km, keyed by calendar month. Null until the
 *  bundle lands, and null forever if it does not -- the forms fall back to the
 *  standard column rather than inventing a slope. */
export type LapseTable = Record<number, { L: number; n: number }> | null

/** Monthly-normal pad state, keyed by station then calendar month. Already
 *  reduced to the pad: pressure inverted from the altimeter setting, and
 *  temperature carried across the station/pad elevation gap. */
export type PadNormals =
  Record<string, Record<number, { T: number | null; p: number; n: number }>> | null

export interface PadClimatology {
  lapseByMonth: LapseTable
  padNormals: PadNormals
}

/**
 * The pooled Edwards + China Lake lapse dataset, and the per-station monthly
 * normals.
 *
 * `edw-nid` is the default in site-climatology and the only dataset inside
 * 50 km of the pad. It is the same source the Atmospheric Data tab plots, so
 * the number offered in a form and the curve shown there cannot disagree.
 */
export function usePadClimatology(): PadClimatology {
  const [lapseByMonth, setLapseByMonth] = useState<LapseTable>(null)
  const [padNormals, setPadNormals] = useState<PadNormals>(null)

  useEffect(() => {
    let live = true
    getClimatology().then((res) => {
      if (!live || !res.data) return

      const rows = res.data.upper.lapse['edw-nid']
      if (rows) {
        const table: Record<number, { L: number; n: number }> = {}
        for (const r of rows) table[r.month] = { L: r.L_mean, n: r.n }
        setLapseByMonth(table)
      }

      const normals: NonNullable<PadNormals> = {}
      for (const [icao, months] of Object.entries(res.data.surface.monthly)) {
        const byMonth: Record<number, { T: number | null; p: number; n: number }> = {}
        for (const m of months) {
          // Launch-window temperature (15-23Z, roughly 8am-4pm local) when the
          // month has one. A 24 h mean is several kelvin colder than any hour
          // anyone launches in, and temperature is the input worth ~7% in
          // density. Pressure has no meaningful diurnal signal at this scale,
          // so the all-hours mean is used for it either way.
          byMonth[m.month] = {
            T: m.lw_t_mean ?? m.t_mean,
            p: m.p_mean,
            n: m.lw_t_mean !== null ? m.lw_n : m.n,
          }
        }
        normals[icao] = byMonth
      }
      setPadNormals(normals)
    })
    return () => { live = false }
  }, [])

  return { lapseByMonth, padNormals }
}
