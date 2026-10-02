import { useEffect, useRef } from "react";
import uPlot from "uplot";

import { useDark } from "../theme";
import { CARD } from "../ui";

export type Line = { label: string; values: (number | null)[]; slot: 1 | 2 | 3 };

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * One measure per chart, one y-axis, at most three series in the validated
 * categorical slots. uPlot's legend is the hover readout: it shows the time
 * and every series' value under the crosshair.
 */
export function Chart({
  title,
  ts,
  lines,
  fmt,
  yMax,
  span,
  height = 180,
}: {
  title: string;
  ts: number[]; // unix ms
  lines: Line[];
  fmt: (v: number) => string;
  yMax?: number; // fixed ceiling, e.g. 100 for percentages or total RAM
  span?: number; // ms: draw the whole selected range ending now, not just the data's extent
  height?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const dark = useDark();

  useEffect(() => {
    const root = el.current;
    if (!root) return;
    const axis = cssVar("--chart-axis");
    const grid = cssVar("--chart-grid");
    const opts: uPlot.Options = {
      width: root.clientWidth,
      height,
      cursor: { points: { size: 8 }, drag: { x: false, y: false } },
      legend: { show: true, live: true },
      scales: {
        x: span
          ? { time: true, range: () => [(Date.now() - span) / 1000, Date.now() / 1000] }
          : { time: true },
        y: { range: (_u, _min, max) => [0, yMax ?? (max > 0 ? max * 1.1 : 1)] },
      },
      axes: [
        { stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid } },
        {
          stroke: axis,
          grid: { stroke: grid, width: 1 },
          ticks: { show: false },
          size: 64,
          values: (_u, vals) => vals.map((v) => fmt(v)),
        },
      ],
      series: [
        { value: (_u, v) => (v == null ? "—" : new Date(v * 1000).toLocaleString()) },
        ...lines.map((l) => ({
          label: l.label,
          stroke: cssVar(`--series-${l.slot}`),
          width: 2,
          points: { show: false },
          spanGaps: false,
          value: (_u: uPlot, v: number | null) => (v == null ? "—" : fmt(v)),
        })),
      ],
    };
    const data: uPlot.AlignedData = [ts.map((t) => t / 1000), ...lines.map((l) => l.values)];
    plot.current?.destroy();
    plot.current = new uPlot(opts, data, root);
    const ro = new ResizeObserver(() => plot.current?.setSize({ width: root.clientWidth, height }));
    ro.observe(root);
    return () => {
      ro.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
  }, [ts, lines, fmt, yMax, span, height, dark]);

  return (
    <div className={CARD}>
      <h3 className="mb-2 text-sm font-medium">{title}</h3>
      {ts.length === 0 ? (
        <div className="flex items-center justify-center text-sm text-neutral-500 dark:text-neutral-400" style={{ height }}>
          No data in this range yet
        </div>
      ) : (
        <div ref={el} className="w-full" />
      )}
    </div>
  );
}
