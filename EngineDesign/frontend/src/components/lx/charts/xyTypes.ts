import type { ColormapName } from './colormap';
import type { ChartEvent, Status } from './types';

/** What an x–y chart is given: a Nyquist plot, the operating map, an x–t heatmap. */

export interface XYSeries {
  key: string;
  /** Named beside its last point (inside the plot, where it crosses nothing). Empty: unnamed. */
  label: string;
  /** A token (`--lx-lox`), `var(...)`, or a CSS colour. Ignored for a ghost. */
  color: string;
  x: readonly (number | null)[];
  y: readonly (number | null)[];
  /**
   * The burn time of each point (the operating map's path): the page's cursor then rides the
   * path as a dot, and hovering near the path scrubs the page.
   */
  t?: readonly number[];
  /** A third value per point read out on hover (a Nyquist plot's frequency). */
  meta?: readonly (number | null)[];
  metaUnit?: string;
  dash?: number[];
  width?: number;
  /** The compared run: grey, 1 px, 70 %. */
  ghost?: boolean;
  /** Dots instead of a line. */
  points?: boolean;
}

/** A labelled point: the design point, the critical point (−1, 0). */
export interface XYMark {
  x: number;
  y: number;
  label?: string;
  shape?: 'dot' | 'cross' | 'diamond' | 'ring';
  /** Default the text colour. */
  color?: string;
}

/** A shaded region (the chug-unstable side of the map), faint in its status colour. */
export interface XYRegion {
  points: readonly (readonly [number, number])[];
  status: Status;
  label?: string;
}

/** A dashed limit line across the plot: horizontal (`axis: 'y'`) or vertical (`axis: 'x'`). */
export interface XYLine {
  axis: 'x' | 'y';
  value: number;
  status: Status;
  label?: string;
}

/**
 * A gridded field drawn under everything: `z[i][j]` is the value at (x[i], y[j]). Cells are
 * centred on the grid points (edges half-way between), so an uneven grid draws true.
 */
export interface HeatLayer {
  x: readonly number[];
  y: readonly number[];
  z: readonly (readonly (number | null)[])[];
  /** Default viridis. */
  colormap?: ColormapName;
  /** The colour scale's ends; default the field's extent. */
  range?: readonly [number, number];
  /** The field's unit, heading the colourbar ("MW/m²", "s"). */
  unit: string;
  /** What the field is, for the readout ("q", "Isp"). */
  name?: string;
  /** Decimals in the readout and on the colourbar; default from the colourbar's step. */
  digits?: number;
  /** Fill the cells (default true). False: the contours alone. */
  fill?: boolean;
  /** Iso-lines at these values, or about `count` round ones. */
  contours?: readonly number[] | { count: number };
  /** Draw the colourbar (default: when filled). */
  colorbar?: boolean;
}

export interface XYData {
  series: readonly XYSeries[];
  heat?: HeatLayer | null;
  marks?: readonly XYMark[];
  regions?: readonly XYRegion[];
  lines?: readonly XYLine[];
  /** The worst point of a series: a ring and a one-line note. */
  worst?: { seriesKey: string; index: number; text: string } | null;
  /** Axis names, short ("O/F", "Pc", "Re"): the y one heads the tick column, the x one rides on
   * the last x tick, each with its unit. */
  xName?: string;
  yName?: string;
  xUnit: string;
  yUnit: string;
  xLog?: boolean;
  xPin?: readonly [number | null, number | null];
  yPin?: readonly [number | null, number | null];
  /** One unit of x is as long as one unit of y (a Nyquist plot). */
  equalAspect?: boolean;
  /** Which axis is the burn clock (an x–t heatmap): the page's cursor is drawn across it and
   * hovering the plot scrubs the page. */
  timeAxis?: 'x' | 'y' | null;
  /** Faint ticks on the time axis. */
  events?: readonly ChartEvent[];
  /** Decimals in the readout per axis; default from the ticks. */
  xDigits?: number;
  yDigits?: number;
}
