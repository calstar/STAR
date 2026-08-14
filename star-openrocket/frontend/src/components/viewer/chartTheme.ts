/**
 * Recharts styling constants for the flight-profile chart.
 *
 * Literal colors rather than `var(--color-...)`: Recharts passes most of these through as SVG
 * presentation attributes, where `var()` is not resolved. Mirrors the slate palette used across
 * star-openrocket (Tailwind slate). Font sizes are plain px and do not track the `--text-*` scale.
 */

export const AXIS = {
  stroke: '#94a3b8', // slate-400
  fontSize: 13,
  tickLine: false,
} as const

/** Tick label size — matches the app's `--text-2xs` (13px) floor so chart text
 *  tracks the rest of the UI instead of the old hard-coded 10–11px. */
export const TICK_FONT = 13

/** Axis-title styling (rotated Y titles included), shared by all flight charts. */
export const axisLabelX = (value: string) =>
  ({ value, position: 'insideBottom' as const, offset: -4, fill: '#cbd5e1', fontSize: 13 })
export const axisLabelY = (value: string) =>
  ({ value, angle: -90, position: 'insideLeft' as const, offset: 4, fill: '#cbd5e1', fontSize: 13, style: { textAnchor: 'middle' as const } })

export const GRID = {
  stroke: '#334155', // slate-700
  strokeDasharray: '3 3',
} as const

export const TOOLTIP_STYLE = {
  backgroundColor: '#0f172a', // slate-900
  border: '1px solid #334155',
  borderRadius: 6,
  fontSize: 13,
} as const

export const TOOLTIP_LABEL_STYLE = {
  color: '#cbd5e1', // slate-300
  fontSize: 12,
  marginBottom: 4,
} as const

/** One color per flight series; distinct hues, readable on the dark ground. */
export const SERIES = {
  altitude: '#22d3ee', // cyan
  velocity: '#34d399', // emerald
  acceleration: '#f59e0b', // amber
  margin: '#e879f9', // fuchsia
} as const

/** Extra hues for the flight-dynamics tab panels. */
export const FD = {
  mach: '#38bdf8', // sky
  pressure: '#f97316', // orange — dynamic pressure / max-Q
  aoa: '#facc15', // yellow — angle of attack
  drift: '#a78bfa', // violet — ground track
  bending: '#fb7185', // rose — loads
  omega: '#2dd4bf', // teal — angular rate
  fft: '#c084fc', // purple — frequency response
  marginOurs: '#e879f9', // fuchsia — our CP margin
  marginRocketpy: '#60a5fa', // blue — RocketPy CP margin
} as const

export const REFERENCE = '#cbd5e1' // slate-300 — burnout / apogee guide lines (legible on dark)
export const REFERENCE_RAIL = '#fbbf24' // amber-400 — off-rail guide line
