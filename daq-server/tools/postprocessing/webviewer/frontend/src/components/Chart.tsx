import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { Series, SeriesMeta } from '../types';
import { colorFor, fmtDuration, mergeForUplot } from '../util';
import { AXIS_FONT, AXIS_STROKE, GRID_STROKE, LABEL_FONT } from '../chartTheme';

interface Props {
  series: Series[];
  meta: SeriesMeta[]; // parallel to series — display name, unit, field, value names
  /** The window currently asked for (epoch seconds) — what the x-axis should show,
   *  which is not the same as the extent of the data that came back for it. */
  view: [number, number];
  /** The whole run (epoch seconds). Zooming out stops here; it is also home. */
  bounds: [number, number];
  minHeight?: number;
  // Called when the user zooms/pans the x-axis (epoch seconds), so the parent
  // can refetch that window at higher resolution.
  onViewChange?: (start: number, end: number) => void;
  /** Double-click, and a wheel zoom-out that reaches the full run. */
  onResetView?: () => void;
  onReady?: (u: uPlot) => void;
}

const stepped = uPlot.paths.stepped!({ align: 1 });

// uPlot axis sides: 1 = right, 3 = left. Group N gets sides in this order, so
// two groups sit left+right and a 3rd/4th stack outward on each side.
const SIDES = [3, 1, 3, 1] as const;

// Compact SI-suffixed tick labels so large magnitudes (e.g. near-uint32 ADC
// counts) stay short and don't collide with the axis label. 4.29e9 → "4.3G".
const SI: [number, string][] = [
  [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'],
];
const fmt = (v: number): string => {
  const a = Math.abs(v);
  for (const [scale, suf] of SI) {
    if (a >= scale) return (v / scale).toFixed(1).replace(/\.0$/, '') + suf;
  }
  return String(+v.toFixed(2));
};

/** Assign each series a y-scale keyed by its unit — or, when it has no unit, by
 *  its field name — so like-united channels share an axis while distinct
 *  unitless field-types (raw_adc_counts vs sample_ts_ms) each get their own.
 *  Returns the scale key per series + the ordered distinct groups (first group
 *  is the primary/grid axis). */
function axisGroups(meta: SeriesMeta[]) {
  const scaleOf = meta.map((m) => m.unit || m.field);
  const order: string[] = [];
  for (const k of scaleOf) if (!order.includes(k)) order.push(k);
  return { scaleOf, order };
}

/** Legend line for one series: what it is, then how to read it. The field suffix
 *  only appears for unitless channels — without it `from_state` and `to_state` both
 *  render as the bare entity and are indistinguishable in the legend. */
const legendLabel = (m: SeriesMeta) =>
  m.label + (m.unit ? ` (${m.unit})` : ` · ${m.field}`);

/** Name an enum value (a state id) for the legend and the axis; unknown ids stay
 *  numeric rather than vanishing — an id with no entry is exactly what you want to see. */
const named = (names: Record<string, string>, v: number) =>
  names[String(v)] ?? String(v);

// One wheel notch changes the window by this much. Small enough that a zoom feels
// continuous, large enough that a few flicks cross a whole run.
const WHEEL_STEP = 0.82;
// Never zoom below a millisecond: past that the window is narrower than the DAQ's own
// sample spacing, and an empty plot with a degenerate scale is not a useful place to be.
const MIN_SPAN_S = 1e-3;

/** Duration of a drag selection. Sub-second windows are the interesting ones on a test
 *  stand (valve travel, ignition transients), so they get milliseconds, not "0.0s". */
const fmtSpan = (s: number): string =>
  s < 1 ? `${(s * 1000).toFixed(0)} ms` : s < 60 ? `${s.toFixed(2)} s` : fmtDuration(s);

// A named axis ticks once per state actually visited, not on uPlot's even spacing —
// past this many distinct values that stops being readable and even ticks win.
const MAX_NAMED_TICKS = 12;

/** Evenly spaced ticks over [min, max] at uPlot's chosen increment — what uPlot's own
 *  default split generator produces, restated here as the fallback for a busy axis. */
function evenSplits(min: number, max: number, incr: number): number[] {
  const out: number[] = [];
  for (let v = Math.ceil(min / incr) * incr; v <= max; v += incr) out.push(v);
  return out;
}

/** The distinct values a scale's series hold, sorted — one tick per state the run was
 *  actually in. `null` when there are too many to label, or none. */
function visitedSplits(u: uPlot, rows: number[]): number[] | null {
  const seen = new Set<number>();
  for (const r of rows) {
    const d = u.data[r];
    for (let i = 0; i < d.length; i++) {
      const x = d[i];
      if (x == null || !Number.isFinite(x)) continue;
      seen.add(x as number);
      if (seen.size > MAX_NAMED_TICKS) return null;
    }
  }
  return seen.size ? [...seen].sort((a, b) => a - b) : null;
}

export default function Chart({
  series, meta, view, bounds, minHeight = 320, onViewChange, onResetView, onReady,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const uRef = useRef<uPlot | null>(null);
  const legendH = useRef(0); // uPlot renders its legend below the canvas
  // Live values for handlers registered once at construction: reading them through refs
  // keeps a pan or a resized window from tearing down and rebuilding the plot.
  const viewCb = useRef(onViewChange);
  viewCb.current = onViewChange;
  const resetCb = useRef(onResetView);
  resetCb.current = onResetView;
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  // Wheel events arrive in bursts; the scale follows every one of them so the zoom feels
  // direct, but the parent (which refetches the window at higher resolution) hears only
  // once the gesture settles.
  const notifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notifyView = (min: number, max: number) => {
    if (notifyTimer.current) clearTimeout(notifyTimer.current);
    notifyTimer.current = setTimeout(() => viewCb.current?.(min, max), 180);
  };

  // Fill the plot to the parent .chart-wrap (which flexes to the viewport),
  // minus the wrap's padding and the legend uPlot draws below the plot. Sizing
  // off the parent's clientHeight is reliable; viewport/top math picked up a
  // stale position during initial layout and under-sized the plot.
  const measure = (el: HTMLElement) => {
    const parent = el.parentElement;
    let avail = 460;
    if (parent) {
      const cs = getComputedStyle(parent);
      const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      avail = parent.clientHeight - padV - legendH.current;
    }
    return {
      width: el.clientWidth || 800,
      height: Math.max(minHeight, avail),
    };
  };

  // Rebuild uPlot when the series set, the axis layout, or the labelling changes —
  // flipping the names toggle rewrites legend labels and axis ticks, which uPlot only
  // picks up on construction.
  const structKey = series
    .map((s, i) => `${s.name}:${s.discrete}:${meta[i].unit}:${meta[i].label}:${meta[i].valueNames ? 'n' : ''}`)
    .join('|');

  useEffect(() => {
    if (!rootRef.current) return;
    const el = rootRef.current;

    const { scaleOf, order } = axisGroups(meta);

    const uSeries: uPlot.Series[] = [
      {},
      ...series.map((s, i) => ({
        label: legendLabel(meta[i]),
        scale: scaleOf[i],
        // A state channel's raw u8 means nothing on its own: show "Fire", not 16.
        value: meta[i].valueNames
          ? (_u: uPlot, v: number | null) => (v == null ? '--' : named(meta[i].valueNames!, v))
          : undefined,
        stroke: colorFor(i),
        width: 1.5,
        spanGaps: !s.discrete,
        paths: s.discrete ? stepped : undefined,
        // Show markers based on THIS series' own non-null sample count in view,
        // not uPlot's default (which keys off the combined x-array length — so
        // selecting a 2nd channel doubles that array and wrongly hides markers
        // on both). A 1-sample series then always draws a visible point.
        points: {
          size: 5,
          show: (u: uPlot, sidx: number, i0: number, i1: number) => {
            const d = u.data[sidx];
            let n = 0;
            for (let i = i0; i <= i1; i++) {
              if (d[i] != null && ++n > 300) return false;
            }
            return true;
          },
        },
      })),
    ];

    // x axis + one y axis per unit group. Grid drawn only for the first group so
    // multiple scales don't stack conflicting gridlines. If a group has exactly
    // one series, colour its axis to match that line.
    const yAxes: uPlot.Axis[] = order.map((scale, gi) => {
      // uPlot data rows are 1-based (row 0 is x), so a series index i is data row i+1.
      const memberRows = scaleOf.flatMap((k, i) => (k === scale ? [i + 1] : []));
      const onlyIdx = memberRows.length === 1 ? scaleOf.indexOf(scale) : -1;
      // Every series on one scale shares a field, so they share a value map too.
      const names = meta[scaleOf.indexOf(scale)].valueNames;
      return {
        scale,
        side: SIDES[gi % SIDES.length],
        size: names ? 108 : 58, // state names are words, not 4 digits
        label: scale,
        labelSize: 26,
        stroke: onlyIdx >= 0 ? colorFor(onlyIdx) : AXIS_STROKE,
        font: AXIS_FONT,
        labelFont: LABEL_FONT,
        grid: { show: gi === 0, stroke: GRID_STROKE, width: 1 },
        ticks: { stroke: GRID_STROKE, width: 1 },
        // Tick where the run actually was — "Idle / Armed / Fire" rather than an even
        // 0/5/10/15/20 ramp through ids nothing ever entered.
        splits: names
          ? (u, _ai, min, max, incr) =>
              visitedSplits(u, memberRows) ?? evenSplits(min, max, incr)
          : undefined,
        values: names
          ? (_u, vals) => vals.map((v) => (Number.isInteger(v) ? named(names, v) : ''))
          : (_u, vals) => vals.map(fmt),
      };
    });

    const opts: uPlot.Options = {
      ...measure(el),
      series: uSeries,
      scales: { x: { time: true } },
      axes: [
        {
          stroke: AXIS_STROKE,
          font: AXIS_FONT,
          grid: { stroke: GRID_STROKE, width: 1 },
          ticks: { stroke: GRID_STROKE, width: 1 },
        },
        ...yAxes,
      ],
      cursor: {
        x: true,
        y: false, // vertical crosshair only — no horizontal line tracking the cursor
        drag: { x: true, y: false },
        bind: {
          // uPlot's default dblclick rescales x to the data extent — which, since we
          // only ever hold the data for the current window, is a no-op that reads as a
          // broken gesture. Make it mean what it looks like: back to the whole run.
          dblclick: () => () => {
            resetCb.current?.();
            return null;
          },
        },
        // Each series lives on its own timestamps with nulls elsewhere (union
        // merge), so the cursor's x-index is null for all but one series. Resolve
        // each series to its NEAREST non-null sample so the legend shows a live
        // value for every line, not just the one that owns that timestamp.
        dataIdx: (u, seriesIdx, hoveredIdx) => {
          const d = u.data[seriesIdx];
          if (d[hoveredIdx] != null) return hoveredIdx;
          let lo = hoveredIdx;
          let hi = hoveredIdx;
          while (lo > 0 && d[lo] == null) lo--;
          while (hi < d.length - 1 && d[hi] == null) hi++;
          const dLo = d[lo] == null ? Infinity : hoveredIdx - lo;
          const dHi = d[hi] == null ? Infinity : hi - hoveredIdx;
          return dHi < dLo ? hi : lo;
        },
      },
      legend: { live: true },
      hooks: {
        // uPlot sizes .u-select as the drag goes but says nothing about it. setCursor is
        // the only per-move hook, so the "you are about to zoom to this" readout rides on
        // it — what the highlighted band is worth in seconds, before you commit to it.
        setCursor: [
          (u) => {
            if (!selLabel) return;
            const { left, width } = u.select;
            if (width <= 0) {
              selLabel.style.display = 'none';
              return;
            }
            selLabel.style.display = '';
            selLabel.style.left = `${left + width / 2}px`;
            selLabel.textContent = fmtSpan(
              u.posToVal(left + width, 'x') - u.posToVal(left, 'x'),
            );
          },
        ],
        // Refetch a higher-res window ONLY on a real user drag-zoom. setSelect
        // fires just for that; using setScale instead caught every programmatic
        // redraw (setData/setSize) and chased the returned data extent forever.
        setSelect: [
          (u) => {
            if (u.select.width <= 0 || !viewCb.current) return;
            const min = u.posToVal(u.select.left, 'x');
            const max = u.posToVal(u.select.left + u.select.width, 'x');
            if (min < max) viewCb.current(min, max);
          },
        ],
      },
    };

    // Declared before opts so the setCursor hook closes over it; filled in below, once
    // uPlot has built the .u-over it lives in.
    let selLabel: HTMLDivElement | null = null;

    const data = mergeForUplot(series) as uPlot.AlignedData;
    const u = new uPlot(opts, data, el);
    uRef.current = u;
    u.setScale('x', { min: view[0], max: view[1] });
    onReady?.(u);

    selLabel = document.createElement('div');
    selLabel.className = 'u-select-span';
    selLabel.style.display = 'none';
    u.over.appendChild(selLabel);

    // Wheel zoom about the cursor: the value under the pointer stays put, so you zoom
    // into what you are looking at rather than the middle of the plot. Clamped to the
    // run at one end and a millisecond at the other.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      const [lo, hi] = boundsRef.current;
      const min = u.scales.x.min ?? lo;
      const max = u.scales.x.max ?? hi;
      const span = max - min;
      if (!(span > 0)) return;
      const out = e.deltaY > 0;
      // Already showing the whole run and still scrolling out: nothing left to do.
      if (out && min <= lo && max >= hi) return;
      e.preventDefault();

      const anchor = u.posToVal(e.clientX - u.over.getBoundingClientRect().left, 'x');
      const frac = (anchor - min) / span;
      const next = Math.min(Math.max(span * (out ? 1 / WHEEL_STEP : WHEEL_STEP), MIN_SPAN_S), hi - lo);
      let nmin = anchor - next * frac;
      let nmax = nmin + next;
      // Slide, don't squash, when a clamp bites — the span the user asked for is kept.
      if (nmin < lo) [nmin, nmax] = [lo, lo + next];
      if (nmax > hi) [nmin, nmax] = [hi - next, hi];

      u.setScale('x', { min: nmin, max: nmax });
      // Back at full extent, hand the parent a clean "no window" rather than bounds that
      // merely happen to equal it — that is what the Reset view button reflects.
      if (nmin <= lo && nmax >= hi && resetCb.current) {
        if (notifyTimer.current) clearTimeout(notifyTimer.current);
        resetCb.current();
      } else {
        notifyView(nmin, nmax);
      }
    };
    u.over.addEventListener('wheel', onWheel, { passive: false });

    // Re-measure the legend from the live element each time (it renders taller
    // transiently before settling, so a one-shot sync read under-sizes the plot)
    // and re-fit. Triggered by: parent resize, legend resize, window resize, and
    // a deferred initial pass after layout settles.
    const legendEl = () => u.root.querySelector('.u-legend') as HTMLElement | null;
    const refit = () => {
      const le = legendEl();
      legendH.current = le ? le.offsetHeight : 0;
      u.setSize(measure(el));
    };
    const ro = new ResizeObserver(refit);
    ro.observe(el.parentElement ?? el); // chart-wrap flex height
    const le = legendEl();
    if (le) ro.observe(le); // legend height settling / wrapping
    window.addEventListener('resize', refit); // viewport-height changes
    requestAnimationFrame(refit); // after initial layout
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', refit);
      u.over.removeEventListener('wheel', onWheel);
      if (notifyTimer.current) clearTimeout(notifyTimer.current);
      u.destroy();
      uRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structKey, minHeight]);

  // Data-only update (same structure): push new samples without rebuilding. The x range
  // is set explicitly rather than left to uPlot's rescale-to-data, which would snap the
  // axis to wherever samples happen to exist — so scrolling out into a quiet stretch
  // would jump back in on every refetch. y scales still auto-range, off this window.
  useEffect(() => {
    const u = uRef.current;
    if (!u) return;
    u.setData(mergeForUplot(series) as uPlot.AlignedData, false);
    u.setScale('x', { min: view[0], max: view[1] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, view[0], view[1]]);

  return <div ref={rootRef} style={{ width: '100%' }} />;
}
