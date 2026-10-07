/**
 * A plot that reads like the DAQ's.
 *
 * Same library (uPlot) and the same behaviour as
 * `daq-server/.../components/plots/TimeSeriesPlot.tsx`: `T+ (s)` on x, 3 px
 * series, no point markers, an x-only cursor, uPlot's own legend off and a
 * row of channel toggles under the plot instead. The ink is the console's --
 * a hairline grid and small grey monospace ticks -- so the traces are the
 * only colour on the panel.
 *
 * The behaviour is kept deliberately in step. Somebody who has spent a night
 * watching the real one should not have to re-learn anything to read a
 * simulated run, and the two traces should be comparable by eye.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

export interface Channel {
  key: string;
  tag: string;
  values: number[];
  color: string;
}

interface Props {
  times: number[];
  channels: Channel[];
  yLabel: string;
  height?: number;
  /** Fill the parent instead of using a fixed height. A pressure plot that owns
   *  its own view should be as tall as the view. */
  fill?: boolean;
  /** Commanded events, drawn as vertical rules. */
  marks?: { t: number; label: string }[];
  /** Offer the log toggle. Off for signed channels, where log has no meaning. */
  allowLog?: boolean;
  /** X axis label. Time is the usual case; the volume sweep is not. */
  xLabel?: string;
  /** The least span the y axis draws, in its own unit: 50 suits psi; an O/F
   *  or a mass flow in kg/s wants a fraction of one. */
  minSpan?: number;
  /** Open on the log axis: residuals span decades. */
  initialLog?: boolean;
  /** Trace width [px]. 3 is the DAQ's; a dense diagnostic trace wants less. */
  lineWidth?: number;
}

/** A stable empty default for `marks`.
 *
 *  `marks = []` in the signature mints a fresh array on every render, which
 *  puts a new identity into the effect's dependency list, which tears the plot
 *  down and rebuilds it. Harmless while nothing re-rendered mid-hover — and
 *  fatal the moment the cursor readout started calling setState from inside
 *  uPlot's own hook: every mouse move destroyed the uPlot instance that was
 *  reporting the move, so the readout could never show anything. */
const NO_MARKS: { t: number; label: string }[] = [];

/** Tick labels: small, monospace, the console's grey. */
const AXIS_FONT = '11px "SF Mono", ui-monospace, Menlo, monospace';

export function fmtAxisVal(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 1) return value.toFixed(1);
  if (abs === 0) return '0';
  // Below a hundredth two decimals read "0.00" for every tick: a residual
  // axis from 1e-9 to 1e-3 was a column of zeros.
  if (abs < 0.01) return value.toExponential(0).replace('e-', 'e−');
  return value.toFixed(2);
}

/** A linear tick label, as precise as the tick spacing and no more.
 *
 *  Fixed decimals cannot serve every axis: two decimals print 0.025 and 0.030
 *  both as "0.03", and on a residual axis every tick as "0.00". The spacing
 *  uPlot chose (`incr`) says how many digits separate neighbours. */
export function fmtTick(value: number, incr: number): string {
  if (value === 0 || Math.abs(value) < Math.abs(incr) * 1e-9) return '0';
  const abs = Math.abs(value);
  const step = incr > 0 && Number.isFinite(incr) ? incr : abs;
  if (abs >= 1e3 && step >= 100) {
    return `${(value / 1e3).toFixed(decimalsOf(step / 1e3))}K`;
  }
  if (step < 1e-3) {
    // As many mantissa digits as the step has at this value's scale, and
    // no trailing zeros, so "1e−9" sits beside "5e−10" and "1.5e−9".
    const scale = 10 ** Math.floor(Math.log10(abs));
    return value
      .toExponential(decimalsOf(step / scale))
      .replace(/\.?0+e/, 'e')
      .replace('e-', 'e−')
      .replace('e+', 'e');
  }
  return value.toFixed(decimalsOf(step));
}

/** Decimal places the step itself has: 0.025 has three, 2.5 one, 500 none.
 *  Taken from the step's digits, not its magnitude -- ceil(-log10(0.025)) is
 *  two, which printed the 0.025 tick as "0.03". */
export function decimalsOf(step: number): number {
  for (let d = 0; d <= 6; d += 1) {
    const scaled = step * 10 ** d;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-6 * Math.max(1, Math.abs(scaled))) return d;
  }
  return 6;
}

/** A log-axis tick: plain where plain is short (1, 10, 0.5), exponent where
 *  it is not (1e−9). */
export function fmtLogTick(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 0.01 && abs < 1e4) return String(Number(value.toPrecision(3)));
  return value.toExponential(0).replace('e-', 'e−').replace('e+', 'e');
}

/** A reading under the cursor: three to four significant figures, never
 *  rounded to the axis's coarseness (a residual of 6.3e-5 read "6e−5", and a
 *  time of 1,640 s read "1.6K"). */
export function fmtReading(value: number): string {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e4) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (abs >= 1) return Number(value.toPrecision(4)).toLocaleString('en-US', { maximumFractionDigits: 3 });
  if (abs >= 0.01) return String(Number(value.toPrecision(3)));
  return value.toExponential(2).replace('e-', 'e−');
}

/** Width the y axis needs for its widest label [px]: 11 px monospace is under
 *  7.3 px a character, so this errs wide, plus the tick and gap. A fixed 60 px clipped
 *  "−1.8e−12". */
export function axisWidth(labels: (string | null | undefined)[]): number {
  const widest = Math.max(0, ...labels.map((l) => (l ? l.length : 0)));
  return Math.max(44, Math.ceil(widest * 7.3) + 18);
}

/** The log axis's range [lo, hi], whole decades around the positive samples,
 *  or null when there is nothing above zero to put on a log axis.
 *
 *  Computed here rather than left to uPlot: a log scale over a series with no
 *  positive sample has no range, uPlot lays the axis out from NaN, and the
 *  axis lands hundreds of pixels off the panel. */
/** `m`×10^`e`, parsed from its decimal literal so it is the nearest double.
 *  `10 ** -4` is 0.00009999999999999999 on some V8 builds (CI's Node), and a
 *  decade a hair under itself is a tick the filter drops. */
export function decade(e: number, m = 1): number {
  return Number(`${m}e${e}`);
}

export function logRange(series: number[][]): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const values of series) {
    for (const v of values) {
      if (Number.isFinite(v) && v > 0) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  if (!Number.isFinite(lo)) return null;
  let a = Math.floor(Math.log10(lo));
  let b = Math.ceil(Math.log10(hi));
  if (b <= a) b = a + 1;
  return [decade(a), decade(b)];
}

/** A step of 1, 2, 2.5 or 5 times a power of ten near `raw`. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const p = decade(Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

/** A linear range whose ends sit on whole ticks, about four divisions.
 *
 *  Padding the data range by 5 % left the top of a curve above the last
 *  labelled line -- a mass balance climbing to 0.0199 kg had "0.01" as its
 *  highest number. Ends rounded out to the step are always labelled. */
export function niceRange(lo: number, hi: number): [number, number] {
  if (!(hi > lo)) return [lo - 1, lo + 1];
  const step = niceStep((hi - lo) / 4);
  let a = Math.floor(lo / step) * step;
  let b = Math.ceil(hi / step) * step;
  // Data exactly on the top line reads as clipped; give it one more step.
  if (hi >= b - step * 1e-9 && hi > 0) b += step;
  if (lo <= a + step * 1e-9 && lo < 0) a -= step;
  return [a, b];
}

/** Log-axis ticks: whole decades only, thinned so labels never crowd.
 *
 *  uPlot's own log splits put a line at every 1..9 multiple of every decade;
 *  across the twelve decades a continuity trace spans that is a hundred lines
 *  in two hundred pixels -- a grey wall, not a grid. */
export function decadeSplits(min: number, max: number, most = 6): number[] {
  if (!(min > 0) || !(max > 0)) return [];
  const lo = Math.floor(Math.log10(min));
  const hi = Math.ceil(Math.log10(max));
  // Under two decades, whole decades alone leave one label on the axis; 2 and
  // 5 of each decade fill it the way a log grid on paper does.
  const mantissas = hi - lo <= 2 ? [1, 2, 5] : [1];
  const step = Math.max(1, Math.ceil((hi - lo) / Math.max(most - 1, 1)));
  const out: number[] = [];
  for (let e = lo; e <= hi; e += step) {
    for (const m of mantissas) {
      const v = decade(e, m);
      if (v >= min * (1 - 1e-9) && v <= max * (1 + 1e-9)) out.push(v);
    }
  }
  return out;
}

export function DaqPlot({
  times,
  channels,
  yLabel,
  height = 240,
  fill = false,
  marks = NO_MARKS,
  allowLog = false,
  xLabel = 'T+ (s)',
  minSpan = 50,
  initialLog = false,
  lineWidth = 3,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  // Silencing a channel, the way the DAQ does it: click its pill and the plot
  // rescales to what is left. That is how you look under a 4500 psi bottle
  // without anyone deciding for you which channels belong together.
  const [silenced, setSilenced] = useState<Set<string>>(new Set());
  const [log, setLog] = useState(initialLog);
  // Which sample the cursor is over, so the pills can read out values at it.
  // The DAQ shows a number under the cursor and this is the same job: a plot
  // you can only eyeball is a plot you cannot quote from.
  const [at, setAt] = useState<number | null>(null);

  const shown = useMemo(
    () => channels.filter((c) => !silenced.has(c.key)),
    [channels, silenced],
  );
  // Log only when there is something to put on it; otherwise the linear axis,
  // and the button says why.
  const range = useMemo(() => (log ? logRange(shown.map((c) => c.values)) : null), [log, shown]);
  const onLog = log && range !== null;
  // What the chart is built around: which series, in which colours. A new
  // poll of the same channels changes the data, not this, and the data goes
  // into the existing chart (`setData`) -- rebuilding it every poll lost the
  // cursor every two seconds, so nothing could be read off a live plot.
  const shape = shown.map((c) => `${c.key}:${c.color}:${c.tag}`).join('|');
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const dataFor = (): uPlot.AlignedData => [
    times,
    ...shown.map((c) => (onLog ? c.values.map((v) => (v > 0 ? v : null)) : c.values)),
  ];
  const dataRef = useRef(dataFor);
  dataRef.current = dataFor;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const marker: uPlot.Plugin = {
      hooks: {
        draw: (u) => {
          const ctx = u.ctx;
          ctx.save();
          ctx.strokeStyle = '#EAB308';
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 1;
          for (const m of marks) {
            const x = u.valToPos(m.t, 'x', true);
            ctx.beginPath();
            ctx.moveTo(x, u.bbox.top);
            ctx.lineTo(x, u.bbox.top + u.bbox.height);
            ctx.stroke();
          }
          ctx.restore();
        },
      },
    };

    const options: uPlot.Options = {
      width: host.clientWidth || 800,
      height: fill ? 300 : height,
      pxAlign: true,
      // Right padding wide enough for the last x label, which uPlot centres on
      // the plot's right edge: at 12 px "1,540" was cut to "1,54(".
      padding: [8, 28, 0, 0],
      // distr 3 is uPlot's log scale. Non-positive samples cannot be plotted
      // on one, so they are dropped to null rather than clamped -- a clamped
      // zero would draw a line at whatever floor was picked and look like data.
      scales: {
        x: { time: false },
        // A vented stand reads a few hundredths of a psi of vent
        // backpressure; auto-ranged to that, the noise fills the panel and
        // looks like an event. Never draw less than 50 psi of span.
        y: onLog
          ? { distr: 3, range: () => rangeRef.current ?? [1, 10] }
          : {
              range: (_u, min, max) => niceRange(Math.min(min, 0), Math.max(max, Math.min(min, 0) + minSpan)),
            },
      },
      axes: [
        {
          label: xLabel,
          stroke: '#7a7a7a',
          grid: { show: true, stroke: '#1c1c1c', width: 1 },
          ticks: { show: true, stroke: '#2a2a2a', width: 1 },
          font: AXIS_FONT,
          labelFont: AXIS_FONT,
          gap: 8,
          // 120 px between time labels suits the full-width console plot; a
          // half-width panel got one label. Scale with the plot's own width.
          space: (_u: uPlot, _axis: number, _min: number, _max: number, dim: number) =>
            dim < 600 ? 64 : 120,
        },
        {
          label: yLabel,
          stroke: '#7a7a7a',
          grid: { show: true, stroke: '#1c1c1c', width: 1 },
          ticks: { show: true, stroke: '#2a2a2a', width: 1 },
          font: AXIS_FONT,
          labelFont: AXIS_FONT,
          size: (_u: uPlot, values: string[] | null) => axisWidth(values ?? []),
          gap: 5,
          // 80 px between labels suits the console's tall plot; a short
          // diagnostic panel would get one label, so it scales with height.
          space: height < 240 ? 36 : 80,
          ...(onLog
            ? {
                // uPlot's own log filter hides labels it thinks crowd; these
                // splits are already thinned, and a gridline with no number
                // on it is the thing being fixed.
                filter: (_u: uPlot, splits: number[]) => splits,
                splits: (u: uPlot) => decadeSplits(u.scales.y.min ?? 0, u.scales.y.max ?? 0) }
            : {}),
          values: (_u, vals, _axis, _space, incr) =>
            vals.map((v) => (v == null ? '' : onLog ? fmtLogTick(v) : fmtTick(v, incr))),
        },
      ],
      series: [
        {},
        ...shown.map((c) => ({
          label: c.tag,
          stroke: c.color,
          width: lineWidth,
          points: { show: false },
        })),
      ],
      cursor: { show: true, x: true, y: false },
      legend: { show: false },
      hooks: {
        setCursor: [(u: uPlot) => setAt(u.cursor.idx ?? null)],
      },
      plugins: marks.length ? [marker] : [],
    };

    plotRef.current = new uPlot(options, dataRef.current(), host);
    const clear = () => setAt(null);
    host.addEventListener('mouseleave', clear);

    const observer = new ResizeObserver(() => {
      if (plotRef.current && host.clientWidth > 0) {
        plotRef.current.setSize({
          width: host.clientWidth,
          height: fill ? host.clientHeight : height,
        });
      }
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      host.removeEventListener('mouseleave', clear);
      plotRef.current?.destroy();
      plotRef.current = null;
    };
    // `shape` stands for `shown`'s identity: the series, not their values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, yLabel, xLabel, height, marks, onLog, fill, minSpan, lineWidth]);

  // New samples into the chart that is already there.
  useEffect(() => {
    plotRef.current?.setData(dataRef.current());
  }, [times, shown, range]);

  /** The value of one channel under the cursor, or null when there is none.
   *
   *  Nulls are real here: a series resampled onto a shared x axis has gaps
   *  where it had no sample, and a gap must read as blank rather than as the
   *  last number that happened to be nearby. */
  const reading = (c: Channel): number | null => {
    if (at === null) return null;
    const v = c.values[at];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };

  const toggle = (key: string) =>
    setSilenced((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else if (next.size < channels.length - 1) next.add(key);
      return next;
    });

  // Filling a panel, the canvas gets what the legend leaves. Sized from its
  // own canvas instead, the host never shrank below the first 300 px and the
  // legend ran out of the panel into whatever sat under it.
  return (
    <div className={fill ? 'flex h-full min-h-0 flex-col' : undefined}>
      {shown.length === 0 ? (
        <div style={fill ? undefined : { height }} className={fill ? 'min-h-0 flex-1' : undefined} />
      ) : (
        <div ref={hostRef} className={fill ? 'min-h-0 w-full flex-1 overflow-hidden' : 'w-full'} />
      )}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 py-3">
        {channels.map((c) => {
          const off = silenced.has(c.key);
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => toggle(c.key)}
              aria-pressed={!off}
              className={`flex flex-shrink-0 items-center gap-2 py-0.5 transition-opacity ${
                off ? 'opacity-35' : ''
              }`}
            >
              <span
                aria-hidden
                className="inline-block h-[2px] w-3"
                style={{ background: off ? 'var(--dim)' : c.color }}
              />
              <span className="font-mono text-[12px] uppercase tracking-[0.08em] text-[var(--ink-3)]">
                {c.tag}
              </span>
              {reading(c) !== null && (
                <span
                  className="font-mono text-[12px] tabular-nums"
                  style={{ color: off ? 'var(--dim)' : 'var(--ink)' }}
                >
                  {fmtReading(reading(c) as number)}
                </span>
              )}
            </button>
          );
        })}
        {at !== null && times[at] !== undefined && (
          <span className="ml-1 font-mono text-[12px] tabular-nums text-[var(--dim)]">
            @ {fmtReading(times[at])}
          </span>
        )}
        {allowLog && (
          <button
            type="button"
            onClick={() => setLog((v) => !v)}
            aria-pressed={log}
            title={log && !onLog ? 'Nothing above zero to put on a log axis; shown linear.' : 'Log y axis'}
            // Lit only when the axis is log: asked for but impossible (nothing
            // above zero) it is dashed, and the tooltip says why.
            className={`ml-auto border px-2 py-0.5 font-mono text-[12px] transition-colors ${
              onLog
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : log
                  ? 'border-dashed border-white/20 text-[var(--dim)]'
                  : 'border-[var(--line-strong)] text-[var(--dim)]'
            }`}
          >
            log
          </button>
        )}
      </div>
    </div>
  );
}
