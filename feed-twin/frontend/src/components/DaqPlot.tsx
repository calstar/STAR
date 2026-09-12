/**
 * A plot that reads like the DAQ's.
 *
 * Same library (uPlot) and the same options as
 * `daq-server/.../components/plots/TimeSeriesPlot.tsx`: `T+ (s)` on x, grid
 * #555, ticks #777, axis labels in bold monospace, 3 px series, no point
 * markers, an x-only cursor, uPlot's own legend off and a row of pills under
 * the plot instead.
 *
 * Kept deliberately in step. Somebody who has spent a night watching the real
 * one should not have to re-learn anything to read a simulated run, and the
 * two traces should be comparable by eye without a translation step.
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

function fmtAxisVal(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 1) return value.toFixed(1);
  return value.toFixed(2);
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
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  // Silencing a channel, the way the DAQ does it: click its pill and the plot
  // rescales to what is left. That is how you look under a 4500 psi bottle
  // without anyone deciding for you which channels belong together.
  const [silenced, setSilenced] = useState<Set<string>>(new Set());
  const [log, setLog] = useState(false);
  // Which sample the cursor is over, so the pills can read out values at it.
  // The DAQ shows a number under the cursor and this is the same job: a plot
  // you can only eyeball is a plot you cannot quote from.
  const [at, setAt] = useState<number | null>(null);

  const shown = useMemo(
    () => channels.filter((c) => !silenced.has(c.key)),
    [channels, silenced],
  );

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
      padding: [8, 12, 0, 0],
      // distr 3 is uPlot's log scale. Non-positive samples cannot be plotted
      // on one, so they are dropped to null rather than clamped -- a clamped
      // zero would draw a line at whatever floor was picked and look like data.
      scales: {
        x: { time: false },
        // A vented stand reads a few hundredths of a psi of vent
        // backpressure; auto-ranged to that, the noise fills the panel and
        // looks like an event. Never draw less than 50 psi of span.
        y: log
          ? { distr: 3 }
          : {
              range: (_u, min, max) => {
                const lo = Math.min(min, 0);
                const hi = Math.max(max, lo + 50);
                const pad = (hi - lo) * 0.05;
                return [lo - (lo < 0 ? pad : 0), hi + pad];
              },
            },
      },
      axes: [
        {
          label: xLabel,
          stroke: '#9CA3AF',
          grid: { show: true, stroke: '#555', width: 1 },
          ticks: { show: true, stroke: '#777', width: 1 },
          font: 'bold 12px monospace',
          labelFont: '12px system-ui',
          gap: 8,
          space: 120,
        },
        {
          label: yLabel,
          stroke: '#9CA3AF',
          grid: { show: true, stroke: '#555', width: 1 },
          ticks: { show: true, stroke: '#777', width: 1 },
          font: 'bold 12px monospace',
          labelFont: '12px system-ui',
          size: 60,
          gap: 5,
          space: 80,
          values: (_u, vals) => vals.map((v) => (v == null ? '' : fmtAxisVal(v))),
        },
      ],
      series: [
        {},
        ...shown.map((c) => ({
          label: c.tag,
          stroke: c.color,
          width: 3,
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

    const data: uPlot.AlignedData = [
      times,
      ...shown.map((c) =>
        log ? c.values.map((v) => (v > 0 ? v : null)) : c.values,
      ),
    ];
    plotRef.current = new uPlot(options, data, host);
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
  }, [times, shown, yLabel, xLabel, height, marks, log, fill]);

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

  return (
    <div>
      {shown.length === 0 ? (
        <div style={{ height }} />
      ) : (
        <div ref={hostRef} className="w-full" />
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2">
        {channels.map((c) => {
          const off = silenced.has(c.key);
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => toggle(c.key)}
              aria-pressed={!off}
              className={`flex flex-shrink-0 items-center gap-2 rounded-md border px-2 py-0.5 transition-opacity ${
                off
                  ? 'border-white/5 bg-transparent opacity-40'
                  : 'border-white/5 bg-black/20'
              }`}
            >
              <span
                aria-hidden
                className="inline-block h-[2px] w-3 rounded-full"
                style={{
                  background: off ? 'var(--dim)' : c.color,
                  boxShadow: off ? 'none' : `0 0 6px ${c.color}80`,
                }}
              />
              <span className="num text-[12px] font-semibold text-[var(--muted)]">
                {c.tag}
              </span>
              {reading(c) !== null && (
                <span
                  className="num text-[12px] font-bold tabular-nums"
                  style={{ color: off ? 'var(--dim)' : c.color }}
                >
                  {fmtAxisVal(reading(c) as number)}
                </span>
              )}
            </button>
          );
        })}
        {at !== null && times[at] !== undefined && (
          <span className="num ml-1 text-[12px] font-semibold tabular-nums text-[var(--dim)]">
            @ {fmtAxisVal(times[at])}
          </span>
        )}
        {allowLog && (
          <button
            type="button"
            onClick={() => setLog((v) => !v)}
            aria-pressed={log}
            className={`num ml-auto rounded-md border px-2 py-0.5 text-[12px] font-semibold transition-colors ${
              log
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-white/5 text-[var(--dim)]'
            }`}
          >
            log
          </button>
        )}
      </div>
    </div>
  );
}
