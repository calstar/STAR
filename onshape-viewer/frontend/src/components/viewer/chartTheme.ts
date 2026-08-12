/**
 * Recharts styling constants for the flight-profile chart.
 *
 * Literal colors rather than `var(--color-...)`: Recharts passes most of these through as SVG
 * presentation attributes, where `var()` is not resolved. Mirrors the slate palette used across
 * onshape-viewer (Tailwind slate). Font sizes are plain px and do not track the `--text-*` scale.
 */

export const AXIS = {
  stroke: '#94a3b8', // slate-400
  fontSize: 12,
  tickLine: false,
} as const

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

export const REFERENCE = '#cbd5e1' // slate-300 — burnout / apogee guide lines (legible on dark)
export const REFERENCE_RAIL = '#fbbf24' // amber-400 — off-rail guide line
