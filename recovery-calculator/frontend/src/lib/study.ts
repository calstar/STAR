/**
 * Design-study variables, and how their values resolve.
 *
 * Pure: no React, no context. Everything that needs a unit takes an injected
 * converter, the same shape `lib/corners.ts` uses, so this module is importable
 * by tests that have no provider tree and the screen still renders in whatever
 * the Units tab says.
 *
 * `physics/study.py` is the other half of the resolver. The GUI shows the
 * resolved grid and the run count BEFORE the backend ever runs, so if the two
 * disagreed the user would be shown a study that is not the one computed. They
 * are held together by a shared case table in `study.test.ts` and
 * `tests/test_study.py`.
 */

import type { UiStudyAxis, WireCanopy, WirePad } from '../types/schema'
import type { Kind } from './quantities'

/** SI value plus its quantity, to a display string. `useUnits().num`. Absent in
 *  tests, which get SI. */
export type Show = (si: number, kind: Kind) => string

/** Whether an axis lives on the vehicle, on one named device, or on the site.
 *  Mirrors `study.VEHICLE_KEYS` / `DEVICE_KEYS` / `SITE_KEYS`. */
export type Scope = 'vehicle' | 'device' | 'site'

export interface StudyVar {
  key: string
  scope: Scope
  /** What the dropdown and the table column say. */
  label: string
  /** The quantity, for variables that have one. Absent means dimensionless
   *  (Cx, n, j) or seconds (delay), which have no imperial form -- see the
   *  deliberate omissions at the top of `quantities.ts`. */
  kind?: Kind
  /** Whole numbers only. `j` is 1 or 2; `n` and the rest are continuous. */
  integer?: boolean
  /** Canopies cannot be interpolated, so no linear mode. */
  listOnly?: boolean
  help: string
}

/**
 * Everything a design study can vary, in menu order.
 *
 * Vehicle first because it is short and the device list repeats per device.
 * Within devices, the catalogue swap leads: it is the question the tab exists
 * for, and the rest are refinements on top of a chosen canopy.
 */
export const STUDY_VARS: StudyVar[] = [
  { key: 'm', scope: 'vehicle', label: 'Descending mass', kind: 'mass',
    help: 'Total mass under the canopy. Note the canopy masses come OUT of '
        + 'this, so swapping to a bigger chute does not raise it on its own.' },
  { key: 'h_a', scope: 'vehicle', label: 'Apogee', kind: 'altitude',
    help: 'How high the flight gets. Sets how long the descent has to run.' },
  { key: 'd_body', scope: 'vehicle', label: 'Airframe diameter', kind: 'length',
    help: 'Body tube diameter. Feeds the airframe drag area through eqs (14) '
        + 'and (15), so it moves the descent even before a canopy is out.' },
  { key: 'l_body', scope: 'vehicle', label: 'Airframe length', kind: 'length',
    help: 'Body tube length. Only enters through the broadside drag bound.' },

  { key: 'canopy', scope: 'device', label: 'Canopy (from catalogue)',
    listOnly: true,
    help: 'Swap the whole canopy: drag area, nominal diameter, mass and cloth '
        + 'type together, from vendor data. Everything about how it is '
        + 'deployed — trigger, delay, packing — stays as configured.' },
  { key: 'CdS', scope: 'device', label: 'Drag area (CdS)', kind: 'area',
    help: 'Full-open drag area. One atomic symbol — never a coefficient times '
        + 'an area (§1.2). Prefer the canopy swap, which keeps D0 and mass '
        + 'consistent with it.' },
  { key: 'D0', scope: 'device', label: 'Nominal diameter (D0)', kind: 'length',
    help: 'Enters only through the filling distance, eq (9) — so it changes '
        + 'how long the canopy takes to open, not how much it drags.' },
  { key: 'm_c', scope: 'device', label: 'Canopy mass', kind: 'mass',
    help: 'Canopy, lines and bag. Comes out of the descending mass, so a '
        + 'heavier canopy means a lighter body, not a heavier vehicle.' },
  { key: 'trigger', scope: 'device', label: 'Deploy trigger',
    help: 'Altitude AGL, or seconds after apogee — whichever this device is '
        + 'set to. The kind is not swept: that would be two designs, not one '
        + 'axis.' },
  { key: 'delay', scope: 'device', label: 'Deployment delay',
    help: 'Charge to line stretch, seconds. 0 free-packed, 0.3–1.0 s bagged. '
        + 'Not a rounding term: it doubles a drogue opening load at 1 s.' },
  { key: 'n', scope: 'device', label: 'Filling constant (n)',
    help: 'Canopy diameters fallen during inflation. Sets the fill time.' },
  { key: 'Cx', scope: 'device', label: 'Opening coefficient (Cx)',
    help: 'Eq (23). The dominant uncertainty in the model — worth sweeping '
        + 'here only to see its effect; the Corners tab already bounds it.' },
  { key: 'j', scope: 'device', label: 'Cloth type (j)', integer: true,
    listOnly: true,
    help: 'Area growth exponent: 2 solid cloth, 1 slotted.' },
  { key: 'v_rel', scope: 'device', label: 'Separation velocity', kind: 'speed',
    help: 'Body-to-canopy speed at line stretch. Drives the snatch load. NOT '
        + 'the descent speed.' },
  { key: 'k_eff', scope: 'device', label: 'Harness stiffness', kind: 'stiffness',
    help: 'Series stiffness of the load path, eq (32). A softer harness cuts '
        + 'the snatch load and does nothing to the opening load.' },

  // Last, because they vary the air rather than the vehicle. Both write the
  // same three site fields and the backend refuses to cross them -- see
  // `Config._check_study`.
  { key: 'pad_source', scope: 'site', label: 'Pad state (pressure source)',
    listOnly: true,
    help: 'Compare where the pad state comes from: the standard column, a pad '
        + 'barometer, the latest METAR, or the station monthly normal. Each '
        + 'point carries the temperature, pressure and lapse rate it resolved '
        + 'to, so it is a comparison of atmospheres, not of labels.' },
  { key: 'pad_month', scope: 'site', label: 'Month (monthly normals)',
    listOnly: true,
    help: 'The same station record, month by month — what the season is worth '
        + 'on descent time and impact speed. Summer air is thinner, so the '
        + 'vehicle descends faster and lands harder on the same canopy.' },
]

/** Site axes, by key. Both carry `pads` rather than numbers, and neither takes
 *  a device: there is one atmosphere over the whole flight. Mirrors
 *  `study.SITE_KEYS`. */
export const SITE_KEYS = ['pad_source', 'pad_month'] as const

export const isSiteKey = (key: string): boolean =>
  (SITE_KEYS as readonly string[]).includes(key)

export function studyVar(key: string): StudyVar | undefined {
  return STUDY_VARS.find((v) => v.key === key)
}

/**
 * The quantity an axis's values are in.
 *
 * `trigger` is the one variable whose unit is not a property of the variable:
 * a device on an ALTITUDE trigger deploys at a height and one on a TIME
 * trigger deploys at a time, and showing seconds in feet would be nonsense. So
 * it is read off the targeted device rather than the table above.
 */
export function axisKind(
  axis: { key: string; device: string | null },
  devices: { name: string; trigger: { kind: string } }[],
): Kind | undefined {
  if (axis.key === 'trigger') {
    const d = devices.find((x) => x.name === axis.device)
    return d?.trigger.kind === 'ALTITUDE' ? 'altitude' : undefined
  }
  return studyVar(axis.key)?.kind
}

/**
 * The values one axis takes, in order. SI in, SI out — units never enter here.
 *
 * Linear includes BOTH ends: `points` is how many values you get, not how many
 * gaps, so 5 points from 800 to 2000 is 800/1100/1400/1700/2000. `points === 1`
 * is the start alone, which makes pinning an axis cost a factor of one rather
 * than being a special case.
 *
 * Identical arithmetic to `study.axis_values` in Python, in the same order, so
 * the two produce bit-identical doubles rather than merely close ones.
 */
export function axisValues(axis: UiStudyAxis): (number | WireCanopy | WirePad)[] {
  if (axis.mode === 'list') {
    if (axis.key === 'canopy') return [...(axis.canopies ?? [])]
    if (isSiteKey(axis.key)) return [...(axis.pads ?? [])]
    return [...(axis.values ?? [])]
  }
  const { start, stop, points } = axis
  if (start === null || stop === null || points === null || points < 1) return []
  if (points === 1) return [start]
  const step = (stop - start) / (points - 1)
  const out: number[] = []
  for (let i = 0; i < points - 1; i += 1) out.push(start + i * step)
  // The last point is `stop` verbatim, not start + (n-1)*step. Those differ in
  // the last digit, and a top-of-range reading 1999.9999999999998 looks like a
  // bug in the physics rather than in IEEE 754.
  out.push(stop)
  return out
}

/** How many designs the study describes: the product over enabled axes. */
export function runCount(axes: UiStudyAxis[]): number {
  return axes
    .filter((a) => a.enabled)
    .reduce((n, a) => n * axisValues(a).length, 1)
}

/** Matches `study.MAX_RUNS`. The backend enforces it; this is so the button
 *  can go grey before anyone presses it. */
export const MAX_RUNS = 20

/** One axis value as text. Canopies show their label; numbers go through the
 *  injected converter when they have a quantity, and are trimmed otherwise so
 *  a table of `n` reads 6 rather than 6.000. */
export function axisValueLabel(
  value: number | string | WireCanopy | WirePad,
  kind?: Kind,
  show?: Show,
): string {
  if (typeof value === 'object') return value.label
  if (typeof value === 'string') return value
  if (kind && show) return show(value, kind)
  return String(Number(value.toFixed(4)))
}

/** What an axis is called on screen: `main · Canopy (from catalogue)`. The
 *  device name leads because with two devices it is the part that disambiguates
 *  two otherwise identical column headers. */
export function axisTitle(axis: { key: string; device: string | null }): string {
  const label = studyVar(axis.key)?.label ?? axis.key
  return axis.device ? `${axis.device} · ${label}` : label
}

