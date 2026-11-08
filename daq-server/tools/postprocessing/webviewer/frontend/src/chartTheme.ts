/*
 * uPlot styling constants.
 *
 * These are literal hex values, not `var(--color-…)`, because uPlot draws axis
 * ticks, labels and the grid onto a <canvas>, where CSS custom properties do
 * not resolve — a `var()` there renders as black (which is exactly why the
 * plots showed unreadable black text before). So this is a hand-kept mirror of
 * the `:root` palette in styles.css: **change a colour there and change it here
 * too.** `theme.check.mjs` asserts these two stay in sync.
 */

export const AXIS_STROKE = '#a3a3a3'; // --color-text-muted (AAA on every bg)
export const GRID_STROKE = '#1f1f1f'; // --color-line: the console's hairline grid
export const AXIS_FONT = '13px "SF Mono", ui-monospace, Menlo, monospace'; // tick values, never below 13px
export const BAND_FILL = '#bdbdbd'; // --color-band: video coverage bands
export const PLAYHEAD_STROKE = '#ededed'; // --color-playhead: the video playhead line
export const LABEL_FONT = '600 13px "SF Mono", ui-monospace, Menlo, monospace'; // axis (unit) label

/*
 * Series palette: ten hues 36° apart at a constant OKLCH L≈0.62, cycled with
 * `i % 10`. Adopted from the recovery-calculator's STUDY_COLOURS, which the
 * dataviz palette validator passes against a dark (#12121a) surface — lightness
 * band, chroma floor, and ≥3:1 contrast all clear. Adjacent hues are close by
 * design (a cycled palette can't keep 10+ channels all maximally distinct), so
 * identity is never colour-alone: the uPlot legend carries the channel name on
 * every row, and that is the real identifier.
 */
export const SERIES_COLOURS = [
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
];

export function seriesColour(i: number): string {
  const n = SERIES_COLOURS.length;
  return SERIES_COLOURS[((i % n) + n) % n];
}
