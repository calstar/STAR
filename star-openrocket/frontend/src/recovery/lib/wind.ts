/**
 * The wind climatology, reduced to what the Drift tab needs, and the resolver
 * that turns a selection into a `WindInput` for the backend.
 *
 * A hook rather than a context, exactly like `usePadClimatology`: the bundle is
 * a one-shot cached fetch, so a second caller costs nothing, and a provider
 * would put the app inside a subscription for a value that never changes after
 * load.
 *
 * The reduction and the resolution both live here, in one place, because the
 * "values travel, not the recipe" contract with the backend means the profile
 * arrays the tab posts have to be built the same way every time -- and the
 * worst-case (p95) construction in particular is a real choice, not a lookup.
 */

import { useEffect, useState } from 'react'
import { getClimatology } from '../api/client'
import type { WindMonth } from '../types/climatology'
import type { WindInput } from '../types/schema'

/** How the tab picks a wind. Climatology mean, its p95 strong-wind sibling, or
 *  a single value the user types. */
export type WindMode = 'climatology' | 'worst' | 'manual'

export interface WindTag {
  id: string
  label: string
}

export interface WindClimatology {
  /** Shared height grid, geopotential metres MSL. Null until the bundle lands. */
  grid_m: number[] | null
  /** dataset tag -> calendar month -> that month's wind. */
  byTag: Record<string, Record<number, WindMonth>> | null
  /** Tags that actually carry wind, with human labels, most-relevant first. */
  tags: WindTag[]
}

/**
 * The pooled Edwards + China Lake set is the default and the only dataset
 * inside 50 km of the pad, so it leads the tag list -- the same dataset the
 * temperature profile and lapse rates come from, so a Drift run and the
 * Atmospheric Data tab cannot disagree about what January looks like.
 */
export function useWindClimatology(): WindClimatology {
  const [state, setState] = useState<WindClimatology>({
    grid_m: null, byTag: null, tags: [],
  })

  useEffect(() => {
    let live = true
    getClimatology().then((res) => {
      if (!live || !res.data) return
      const wind = res.data.upper.wind
      if (!wind) return

      const labelOf: Record<string, string> = {}
      for (const d of res.data.upper.datasets) labelOf[d.id] = d.label

      const byTag: Record<string, Record<number, WindMonth>> = {}
      for (const [tag, months] of Object.entries(wind)) {
        const byMonth: Record<number, WindMonth> = {}
        for (const m of months) byMonth[m.month] = m
        byTag[tag] = byMonth
      }

      // edw-nid first (the pooled default), then the rest alphabetical.
      const tags = Object.keys(byTag)
        .sort((a, b) => (a === 'edw-nid' ? -1 : b === 'edw-nid' ? 1
          : a.localeCompare(b)))
        .map((id) => ({ id, label: labelOf[id] ?? id }))

      setState({ grid_m: res.data.upper.grid_m, byTag, tags })
    })
    return () => { live = false }
  }, [])

  return state
}

/** (u_east, v_north) m/s from a speed and the bearing the wind blows FROM.
 *  The same meteorological convention as physics/wind.py. */
export function uvFromSpeedDir(speed: number, directionFrom: number): [number, number] {
  const r = (directionFrom * Math.PI) / 180
  return [-speed * Math.sin(r), -speed * Math.cos(r)]
}

/**
 * Build the `WindInput` for a climatology month.
 *
 * The **mean** profile posts the mean vector at each level directly. The
 * **worst-case** profile keeps the mean bearing at each level but swaps in the
 * p95 speed -- a coherent strong-wind vector profile, which is what a
 * deterministic worst-case drift wants, rather than the (incoherent) p95 of
 * each component independently.
 */
export function profileWindInput(
  wm: WindMonth, grid: number[], worst: boolean,
): WindInput {
  if (!worst) {
    return { kind: 'profile', heights_msl: grid, u: wm.u, v: wm.v }
  }
  const u: number[] = []
  const v: number[] = []
  for (let i = 0; i < grid.length; i++) {
    const [uu, vv] = uvFromSpeedDir(wm.spd_p95[i], wm.dir[i])
    u.push(uu)
    v.push(vv)
  }
  return { kind: 'profile', heights_msl: grid, u, v }
}
