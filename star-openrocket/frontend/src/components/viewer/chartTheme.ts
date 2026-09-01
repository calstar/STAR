/**
 * Recharts styling constants for the flight-profile chart.
 *
 * Literal colors rather than `var(--color-...)`: Recharts passes most of these
 * through as SVG presentation attributes, where `var()` is not resolved. Each
 * one below names the token it mirrors, and `chartTheme.test.ts` asserts the
 * pairing still holds -- that test is the only thing keeping these in step with
 * index.css, since the compiler cannot see the connection.
 *
 * The chrome (axes, grid, tooltip, font) is deliberately identical to
 * recovery/components/chartTheme.ts so a flight chart and a descent chart read
 * as the same application. The SERIES and FD hues below are NOT shared: they
 * identify specific traces people have been reading for months.
 */

export const AXIS = {
  stroke: '#9fb0c4', // --color-text-muted
  fontSize: 13,
  tickLine: false,
} as const

/** Tick label size — matches the app's `--text-2xs` (13px) floor so chart text
 *  tracks the rest of the UI instead of the old hard-coded 10–11px. */
export const TICK_FONT = 13

/** Axis-title styling (rotated Y titles included), shared by all flight charts. */
export const axisLabelX = (value: string) =>
  ({ value, position: 'insideBottom' as const, offset: -4, fill: '#cbd5e1', fontSize: 13 }) // --color-text-secondary
export const axisLabelY = (value: string) =>
  ({ value, angle: -90, position: 'insideLeft' as const, offset: 4, fill: '#cbd5e1', fontSize: 13, style: { textAnchor: 'middle' as const } })

export const GRID = {
  stroke: '#383848', // --color-border
  strokeDasharray: '3 3',
} as const

export const TOOLTIP_STYLE = {
  backgroundColor: '#12121a', // --color-bg-secondary
  border: '1px solid #383848', // --color-border
  borderRadius: 6,
  fontSize: 14,
  // Without this, Recharts' tooltip text is SVG-adjacent and falls back to the
  // browser's default serif rather than inheriting the page's UI face.
  fontFamily: 'system-ui, sans-serif',
} as const

export const TOOLTIP_LABEL_STYLE = {
  color: '#cbd5e1', // --color-text-secondary
  fontSize: 13,
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
  wind: '#22d3ee', // cyan — ambient wind the rocket flies through
} as const

export const REFERENCE = '#cbd5e1' // --color-text-secondary — burnout / apogee guide lines
export const REFERENCE_RAIL = '#fbbf24' // amber-400 — off-rail guide line
