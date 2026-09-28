/**
 * True-scale axes for the gas-side contour: one millimetre is the same number of pixels on
 * both axes.
 *
 * The frame around the plot is fixed, so the plot area is known exactly and the two scales
 * can be made equal. (Fitting the domains to the whole card, header and legend included, is
 * what drew the contour stretched in radius before.)
 */

/** Space around the plot area [px]. The chart passes these to recharts verbatim. */
export const CONTOUR_FRAME = { top: 22, right: 24, bottom: 8, left: 14, yAxis: 72, xAxis: 44 };

/** 1, 2 or 5 x 10^k, the smallest at or above `raw`. */
export function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

function ticks(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + 1e-9 * step; k++) out.push(+(k * step).toPrecision(12));
  return out;
}

export interface ContourLayout {
  xDomain: [number, number];
  yDomain: [number, number];
  /** One step on both axes, so a grid square is a square. */
  xTicks: number[];
  yTicks: number[];
  step: number;
  /** Whole chart size [px]. The width can be less than offered: a tall part is not padded out. */
  width: number;
  height: number;
  plotW: number;
  plotH: number;
  /** Pixels per unit length, the same on both axes. */
  scale: number;
}

/** Least room between tick labels [px]. */
const TICK_PX = 60;

/**
 * Domains, ticks and chart size for a contour spanning [xMin, xMax] with maximum radius rMax
 * (any one length unit). `full` shows both halves. One scale on both axes, and the chart always
 * fills the offered width: a long part sets the scale by its length; a short, wide one would make
 * the chart taller than `maxPlotH`, so the scale comes from the height instead and the axial range
 * is widened evenly either side of the part (the part sits centred, as in a CAD viewport).
 */
export function contourLayout(
  xMin: number, xMax: number, rMax: number, full: boolean, width: number, maxPlotH = 300,
): ContourLayout {
  const F = CONTOUR_FRAME;
  const plotW = Math.max(100, Math.floor(width - F.left - F.right - F.yAxis));
  const span = Math.max(xMax - xMin, 1e-9);
  const xr0 = span * 1.06;
  const yTop = 1.08 * rMax;
  const yr0 = full ? 2 * yTop : yTop;
  let scale = plotW / xr0;
  let plotH = Math.floor(scale * yr0);
  if (plotH > maxPlotH) {
    plotH = maxPlotH;
    scale = plotH / yr0;
  }
  const xr = plotW / scale;
  const xc = 0.5 * (xMin + xMax);
  const x0 = xc - 0.5 * xr;
  const x1 = xc + 0.5 * xr;
  const yHi = full ? plotH / scale / 2 : plotH / scale;
  const y0 = full ? -yHi : 0;
  const step = niceStep(TICK_PX / scale);
  return {
    xDomain: [x0, x1],
    yDomain: [y0, yHi],
    xTicks: ticks(x0, x1, step),
    yTicks: ticks(y0, yHi, step),
    step,
    width: plotW + F.left + F.right + F.yAxis,
    height: plotH + F.top + F.bottom + F.xAxis,
    plotW,
    plotH,
    scale,
  };
}
