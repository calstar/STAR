/**
 * Recharts styling constants. Kept separate from any component so the
 * react-refresh lint rule stays happy and so both tabs share one look.
 *
 * These are literal values rather than `var(--color-...)` because Recharts
 * passes most of them through as SVG *presentation attributes*, where `var()`
 * is not resolved -- it works in a `style` object and silently renders black
 * everywhere else. So they are a hand-kept mirror of the `:root` palette in
 * index.css: **change a colour there and change it here too.** Likewise the
 * font sizes are plain numbers in px and do not track the `--text-*` scale,
 * which is why that scale is defined in absolute sizes rather than as a root
 * font-size multiplier the charts would not see.
 */

import type { Kind } from '../../lib/units/quantities'

export const AXIS = {
  stroke: '#9fb0c4', // --color-text-muted
  fontSize: 13,
  tickLine: false,
} as const

export const GRID = {
  stroke: '#383848', // --color-border
  strokeDasharray: '3 3',
} as const

export const TOOLTIP_STYLE = {
  backgroundColor: '#12121a',
  border: '1px solid #383848',
  borderRadius: 6,
  fontSize: 14,
  fontFamily: 'system-ui, sans-serif',
} as const

export const TOOLTIP_LABEL_STYLE = {
  color: '#cbd5e1', // --color-text-secondary
  fontSize: 13,
  marginBottom: 4,
} as const

/** Recharts wants explicit margins or the axis labels clip. The bottom margin
 *  carries both a tick row and an axis title, so it grew with the font. */
export const MARGIN = { top: 8, right: 16, bottom: 34, left: 8 } as const

export function axisLabel(value: string, angle = 0) {
  return {
    value,
    angle,
    position: angle === -90 ? ('insideLeft' as const) : ('insideBottom' as const),
    offset: angle === -90 ? 10 : -22,
    style: { fill: '#cbd5e1', fontSize: 13, textAnchor: 'middle' as const },
  }
}

/**
 * The flight-history channels, shared by the Recovery results chart and the
 * Corners chart so the two tabs offer the same axes with the same units.
 *
 * `kind` rather than a literal unit string: both charts convert their DATA
 * through it, not just the axis label, because the ticks, the tooltip and the
 * domain all have to agree. `suffix` is for the part of the label that is not
 * the unit -- "AGL" stays true whichever altitude unit is chosen.
 */
export type Channel = 'z' | 'v' | 'a' | 'F_T' | 'CdS_tot'

export const CHANNELS: {
  key: Channel; label: string; kind: Kind; suffix?: string; colour: string
}[] = [
  { key: 'z', label: 'altitude', kind: 'altitude', suffix: ' AGL', colour: '#3b82f6' },
  { key: 'v', label: 'velocity', kind: 'speed', colour: '#22c55e' },
  { key: 'a', label: 'acceleration', kind: 'accel', colour: '#a855f7' },
  { key: 'F_T', label: 'tension', kind: 'force', colour: '#ef4444' },
  { key: 'CdS_tot', label: 'CdS total', kind: 'area', colour: '#f59e0b' },
]

/**
 * Identity colours for the corner sweep.
 *
 * A separate constant from SERIES_COLOURS, which the atmosphere tab uses,
 * because that one does NOT pass colour-blindness validation on this surface:
 * its teal and pink sit at ΔE 3.7 under deuteranopia, well under the 8 needed
 * to tell two adjacent series apart. These six pass all six checks against
 * #12121a -- lightness band, chroma floor, CVD separation, normal-vision
 * floor, and contrast.
 *
 * Assigned in fixed order and never cycled. Beyond six corners the answer is
 * not a seventh hue but the muted context layer -- see CornerChart.
 */
export const CORNER_COLOURS = [
  '#3987e5', // blue
  '#d95926', // orange
  '#199e70', // aqua
  '#c98500', // yellow
  '#d55181', // magenta
  '#9085e9', // violet
]

/** Unselected corners in the "show all" context layer. One neutral, no
 *  identity, no legend entry -- the "fold into Other" rule, which is what
 *  keeps 32 lines from needing 32 hues.
 *
 *  Light enough to survive being drawn at partial opacity. #6b7280 at 25% over
 *  #12121a blends to about #26272d, which is the background: the toggle looked
 *  broken because nothing visible appeared. */
export const CONTEXT_COLOUR = '#94a3b8'
export const CONTEXT_OPACITY = 0.45

/** The un-perturbed run, drawn as a reference against the corners. Deliberately
 *  outside CORNER_COLOURS -- it is not one of the 32 and must not read as one. */
export const NOMINAL_COLOUR = '#f8fafc'

/** Six identity colours, so six selected corners. Past that the honest move is
 *  the muted context layer rather than a seventh hue nobody can name. */
export const MAX_SELECTED = CORNER_COLOURS.length

/** Colour by position in the selection, so unticking the first corner does not
 *  repaint the other five -- colour follows the corner, never its rank in a
 *  sorted table. Anything unselected is the anonymous context grey. */
export function colourFor(selectedIds: string[], id: string): string {
  const i = selectedIds.indexOf(id)
  return i < 0 ? CONTEXT_COLOUR : CORNER_COLOURS[i]
}

/**
 * Design-study colours: ten hues, cycled.
 *
 * A different rule from CORNER_COLOURS above, because the data is different. A
 * corner is an unordered category -- `Cx1.8 n6 axial` has no position relative
 * to `Cx1.2 n12 broadside` -- so identity has to be unambiguous and the cap is
 * however many hues stay tellable apart, which is six. A study is ORDERED: the
 * points walk a grid, so neighbouring lines are neighbouring designs and
 * looking related is correct rather than a defect.
 *
 * So these are ten hues 36 degrees apart around the wheel at a constant OKLCH
 * L = 0.62, assigned by position in the sweep and cycled with `i % 10`. Two
 * consequences, both deliberate:
 *
 *   * adjacent lines are adjacent hues, so a sweep reads as a progression;
 *   * a repeat is exactly ten steps away, which is as far apart as a cycled
 *     palette can put them.
 *
 * Checked with the dataviz skill's validate_palette.js against the #12121a
 * chart surface: lightness band PASS (all ten inside the 0.48-0.67 dark band),
 * chroma floor PASS, contrast PASS (all >= 3:1). The adjacent-pair CVD and
 * normal-vision checks FAIL, knowingly -- that is what hue ordering means, and
 * any two lines two or more steps apart clear both comfortably (ΔE 18.7 normal,
 * 7.8 deutan). Because adjacent hues are close and colours repeat, **identity
 * here is never colour-alone**: the table under the chart carries a swatch and
 * a label on every row, and that is the identifier.
 */
export const STUDY_COLOURS = [
  '#de4e4b', // red
  '#c16f0f', // orange
  '#9c850c', // olive
  '#599b00', // green
  '#159d7a', // teal
  '#0698a4', // cyan
  '#138fd2', // blue
  '#6e76f0', // indigo
  '#ab5fd2', // violet
  '#d04e97', // magenta
]

/** Colour by position in the study, wrapping at ten. Position, not selection
 *  order: a design keeps its colour when another is hidden, so two screenshots
 *  of the same study never disagree about which line is which. */
export function studyColour(i: number): string {
  return STUDY_COLOURS[((i % STUDY_COLOURS.length) + STUDY_COLOURS.length)
    % STUDY_COLOURS.length]
}
