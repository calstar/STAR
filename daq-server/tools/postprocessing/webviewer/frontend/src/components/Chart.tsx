import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { Series } from '../types';
import { colorFor, mergeForUplot } from '../util';
import { AXIS_FONT, AXIS_STROKE, GRID_STROKE, LABEL_FONT } from '../chartTheme';

interface Props {
  series: Series[];
  units: string[]; // parallel to series
  minHeight?: number;
  // Called when the user zooms/pans the x-axis (epoch seconds), so the parent
  // can refetch that window at higher resolution.
  onViewChange?: (start: number, end: number) => void;
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

const fieldOf = (name: string) => name.split('.').pop() || name;

/** Assign each series a y-scale keyed by its unit — or, when it has no unit, by
 *  its field name — so like-united channels share an axis while distinct
 *  unitless field-types (raw_adc_counts vs sample_ts_ms) each get their own.
 *  Returns the scale key per series + the ordered distinct groups (first group
 *  is the primary/grid axis). */
function axisGroups(series: Series[], units: string[]) {
  const scaleOf = series.map((s, i) => units[i] || fieldOf(s.name));
  const order: string[] = [];
  for (const k of scaleOf) if (!order.includes(k)) order.push(k);
  return { scaleOf, order };
}

export default function Chart({ series, units, minHeight = 320, onViewChange, onReady }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const uRef = useRef<uPlot | null>(null);
  const suppress = useRef(false); // ignore setScale fired by our own setData
  const legendH = useRef(0); // uPlot renders its legend below the canvas
  const viewCb = useRef(onViewChange);
  viewCb.current = onViewChange;

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

  // Rebuild uPlot when the series set OR the axis layout (units) changes.
  const structKey = series.map((s, i) => `${s.name}:${s.discrete}:${units[i]}`).join('|');

  useEffect(() => {
    if (!rootRef.current) return;
    const el = rootRef.current;

    const { scaleOf, order } = axisGroups(series, units);

    const uSeries: uPlot.Series[] = [
      {},
      ...series.map((s, i) => ({
        label: s.name.replace(/\.[^.]+$/, '') + (units[i] ? ` (${units[i]})` : ''),
        scale: scaleOf[i],
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
      const members = series.filter((_, i) => scaleOf[i] === scale);
      const onlyIdx = members.length === 1 ? scaleOf.indexOf(scale) : -1;
      return {
        scale,
        side: SIDES[gi % SIDES.length],
        size: 58,
        label: scale,
        labelSize: 26,
        stroke: onlyIdx >= 0 ? colorFor(onlyIdx) : AXIS_STROKE,
        font: AXIS_FONT,
        labelFont: LABEL_FONT,
        grid: { show: gi === 0, stroke: GRID_STROKE, width: 1 },
        ticks: { stroke: GRID_STROKE, width: 1 },
        values: (_u, vals) => vals.map(fmt),
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
        setScale: [
          (u, key) => {
            if (key !== 'x' || suppress.current) return;
            const { min, max } = u.scales.x;
            if (min != null && max != null && viewCb.current) viewCb.current(min, max);
          },
        ],
      },
    };

    const data = mergeForUplot(series) as uPlot.AlignedData;
    suppress.current = true;
    const u = new uPlot(opts, data, el);
    suppress.current = false;
    uRef.current = u;
    onReady?.(u);

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
      u.destroy();
      uRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structKey, minHeight]);

  // Data-only update (same structure): push new samples without rebuilding.
  useEffect(() => {
    const u = uRef.current;
    if (!u) return;
    suppress.current = true;
    u.setData(mergeForUplot(series) as uPlot.AlignedData);
    suppress.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series]);

  return <div ref={rootRef} style={{ width: '100%' }} />;
}
