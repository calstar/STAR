/** What a Layer X chart is given. */

export type Status = 'ok' | 'warn' | 'bad';

export interface ChartSeries {
  /** Stable id: a focus request whose key matches rings this series' point. */
  key: string;
  /** Named at the line's right end and in the readout. Empty: no direct label. */
  label: string;
  /** A token (`--lx-lox`), `var(--lx-lox)`, or a plain CSS colour. Ignored for a ghost. */
  color: string;
  /** One value per `t`; null is a gap. */
  values: readonly (number | null)[];
  /** Canvas dash in CSS px, e.g. [4, 3]. */
  dash?: number[];
  /** Line width [CSS px]; default 1.5, a ghost is always 1. */
  width?: number;
  /** The compared run: grey, 1 px, 70 %, under the rest. */
  ghost?: boolean;
}

/** A shaded range of acceptable values, faint in its status colour. */
export interface ChartBand {
  lo: number;
  hi: number;
  status: Status;
}

/** A shaded stretch of the x axis (a start window, a trip): neutral unless given a status. */
export interface ChartSpan {
  from: number;
  to: number;
  status?: Status;
}

/** A dashed limit line across the plot, named at its right end beside the series' labels. */
export interface ChartLimit {
  value: number;
  status: Status;
  /** Short: "1.2", "unstable below 1", "MAWP". Empty: the line alone. */
  label: string;
}

/** The worst point of a graded quantity: a ring and a one-line note ("min 35.6 % at 3.52 s"). */
export interface ChartWorst {
  seriesKey: string;
  index: number;
  text: string;
}

/** A faint tick on the time axis. Compatible with the TimeStore's events. */
export interface ChartEvent {
  t: number;
  key?: string;
  label?: string;
  kind?: string;
}

export interface ChartData {
  /** The x values: the burn's clock by default, or any ascending axis with `xTime: false`. */
  t: readonly number[];
  series: readonly ChartSeries[];
  /** The y unit: "psia", "kN", "%". It heads the y tick column, beside the readout row. */
  yUnit: string;
  band?: ChartBand | null;
  /** More bands, drawn under `band`. */
  bands?: readonly ChartBand[];
  /** Shaded x ranges, under everything. */
  spans?: readonly ChartSpan[];
  limits?: readonly ChartLimit[];
  worst?: ChartWorst | null;
  events?: readonly ChartEvent[];
  /** The x unit, appended to the last x tick; default "s". */
  xLabel?: string;
  /** Decimals in the readout; default: what the y ticks need. */
  digits?: number;
  /** Pin either end of the y axis (null leaves it free), e.g. [0, null]. */
  yPin?: readonly [number | null, number | null];
  /**
   * The x axis is the burn's clock (default). False: any other ascending quantity (a frequency,
   * a station): the chart keeps a cursor of its own that follows the pointer, ignores events and
   * reads the x value out first.
   */
  xTime?: boolean;
  /** A log x axis (a Bode plot); implies `xTime: false`. Values ≤ 0 are not drawn. */
  xLog?: boolean;
}

export const STATUS_TOKEN: Record<Status, string> = {
  ok: '--lx-ok',
  warn: '--lx-warn',
  bad: '--lx-bad',
};
