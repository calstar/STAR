/**
 * Where a part's mass came from, which is the one thing colour encodes.
 *
 * Onshape is the default and reads as neutral. Everything else is a departure
 * from it and gets a colour:
 *
 *   unassigned  red     no material in Onshape and nobody has said what it
 *                       weighs, so it contributes nothing to the centre of mass
 *   assigned    green   no material in Onshape either, but a mass has been
 *                       supplied here, so it counts
 *   overridden  yellow  Onshape did weigh it and someone overrode that number
 *
 * A part that is `materialDefaulted` starts with a mass of exactly zero, so any
 * mass on one can only have been supplied in the viewer -- which is why telling
 * red from green needs nothing but the part itself.
 */

import type { Part } from '../types'

export type MassStatus = 'weighed' | 'assigned' | 'unassigned' | 'overridden'

export function massStatus(part: Part, overridden: boolean): MassStatus {
  if (part.materialDefaulted) return part.mass > 0 ? 'assigned' : 'unassigned'
  return overridden ? 'overridden' : 'weighed'
}

/** The worst state in a group, so a collapsed row cannot hide a red part. */
const SEVERITY: Record<MassStatus, number> = {
  unassigned: 3,
  overridden: 2,
  assigned: 1,
  weighed: 0,
}

export function worstStatus(statuses: MassStatus[]): MassStatus {
  return statuses.reduce<MassStatus>(
    (worst, status) => (SEVERITY[status] > SEVERITY[worst] ? status : worst),
    'weighed',
  )
}

/** Text colour per status; `weighed` is left to the caller's own default. */
export const STATUS_TEXT: Record<MassStatus, string> = {
  weighed: '',
  assigned: 'text-emerald-300',
  unassigned: 'text-red-400',
  overridden: 'text-amber-300',
}

/** Surface colour in the 3D scene, matching STATUS_TEXT. */
export const STATUS_COLOR: Record<MassStatus, string> = {
  weighed: '#94a3b8',
  assigned: '#34d399',
  unassigned: '#f87171',
  overridden: '#f59e0b',
}
