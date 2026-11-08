// uPlot charts. They draw what the backend sent: live batches (already scaled
// with the board's active config) and a flight's decimated lines. The only
// arithmetic here is screen layout: which 30 s are on screen, where a marker goes.

import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { Batch, FlightPlot, PlotSpec } from "./types";

/** x, y, z then extras. Matches the legend dots (`--s0`.. in style.css). */
const SERIES = ["--s0", "--s1", "--s2", "--s3"];

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function axes(): uPlot.Axis[] {
  const stroke = css("--muted");
  const grid = { stroke: css("--grid"), width: 1 };
  const ticks = { stroke: css("--grid"), width: 1 };
  const font = `11px ${css("--font")}`;
  return [
    { stroke, grid, ticks, font, size: 28 },
    { stroke, grid, ticks, font, size: 56, space: 22 },
  ];
}

/** Keep a chart the size of its box. */
function fit(u: uPlot, box: HTMLElement): ResizeObserver {
  const ro = new ResizeObserver(() => {
    const w = Math.floor(box.clientWidth);
    const h = Math.floor(box.clientHeight);
    if (w > 0 && h > 0 && (w !== u.width || h !== u.height)) u.setSize({ width: w, height: h });
  });
  ro.observe(box);
  return ro;
}

/** Rounding for the hover box only: 5 significant digits, no exponent. */
function fmt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  return v.toFixed(a >= 1000 ? 0 : a >= 100 ? 1 : a >= 10 ? 2 : 3);
}

/** A box beside the cursor with the time and each line's value there. */
function hover(xLabel: string, unit: string): uPlot.Plugin {
  let box: HTMLDivElement;
  // The cursor is synced across charts (the dashed line shows on each), but the
  // box only on the chart the mouse is in, so it never hides the others' lines.
  let inside = false;
  return {
    hooks: {
      init: (u) => {
        box = document.createElement("div");
        box.className = "chart-hover";
        u.over.append(box);
        u.over.addEventListener("mouseenter", () => (inside = true));
        u.over.addEventListener("mouseleave", () => ((inside = false), box.classList.remove("show")));
      },
      setCursor: (u) => {
        const { idx, left, top } = u.cursor;
        // Nothing under the cursor (past the end of the data, or in a gap): no box,
        // rather than the nearest point from somewhere else.
        const near = idx != null && left != null && Math.abs(u.valToPos(u.data[0][idx], "x") - left) <= 24;
        if (!inside || idx == null || left == null || left < 0 || top == null || !near) {
          box.classList.remove("show");
          return;
        }
        const rows = u.series
          .slice(1)
          .map((s, j) => {
            const v = u.data[j + 1][idx];
            const name = u.series.length > 2 ? `${s.label} ` : "";
            return `<div><i style="background:${s.stroke as string}"></i>${name}${fmt(v)} ${unit}</div>`;
          })
          .join("");
        box.innerHTML = `<div class="t">${xLabel} ${fmt(u.data[0][idx])} s</div>${rows}`;
        box.classList.add("show");
        const w = box.offsetWidth;
        const h = box.offsetHeight;
        const ow = u.over.clientWidth;
        const oh = u.over.clientHeight;
        const x = left + 14 + w > ow ? left - 14 - w : left + 14;
        const y = Math.min(Math.max(0, top - h / 2), Math.max(0, oh - h));
        box.style.transform = `translate(${Math.max(0, x)}px, ${y}px)`;
      },
    },
  };
}

interface LiveChart {
  u: uPlot;
  x: number[];
  /** null is a break the backend sent: uPlot leaves a gap there. */
  y: (number | null)[][];
}

/** The Live tab's charts: a rolling window, all on the same seconds. */
export class LivePlots {
  private charts: LiveChart[] = [];
  private latest = 0;
  private dirty = false;
  private held = false;
  /** Charts whose next point follows a pause: it gets a break before it. */
  private resumed = new Set<number>();

  /** While paused, arriving samples are dropped, so on resume each chart
   * leaves a gap over the paused stretch instead of joining across it. */
  get paused(): boolean {
    return this.held;
  }
  set paused(v: boolean) {
    if (this.held && !v) this.charts.forEach((_, i) => this.resumed.add(i));
    this.held = v;
  }

  constructor(private windowS: number) {}

  /** Build the charts into `boxes` (one per spec). Once. */
  mount(specs: PlotSpec[], boxes: HTMLElement[]): void {
    if (this.charts.length) return;
    const range = (): [number, number] => [Math.max(0, this.latest - this.windowS), Math.max(this.windowS, this.latest)];
    specs.forEach((spec, i) => {
      const box = boxes[i];
      const opts: uPlot.Options = {
        width: box.clientWidth || 600,
        height: box.clientHeight || 120,
        legend: { show: false },
        plugins: [hover("t", spec.unit)],
        cursor: { sync: { key: "live" }, drag: { x: false, y: false } },
        scales: { x: { time: false, auto: false, range } },
        axes: axes(),
        series: [{}, ...spec.series.map((name, j) => ({ label: name, stroke: css(SERIES[j % SERIES.length]), width: 1.5 }))],
      };
      const chart: LiveChart = { u: new uPlot(opts, [[], ...spec.series.map(() => [])], box), x: [], y: spec.series.map(() => []) };
      fit(chart.u, box);
      this.charts.push(chart);
    });
    const frame = () => {
      if (this.dirty) {
        this.dirty = false;
        for (const c of this.charts) c.u.setData([c.x, ...c.y] as uPlot.AlignedData);
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  private session = -1;

  push(b: Batch): void {
    if (b.session !== this.session) {
      // A new link: its times start again at 0. Nothing from the old one stays.
      this.session = b.session;
      this.clear();
      this.latest = 0;
      this.resumed.clear();
    }
    if (this.paused) return;
    for (const p of b.points) {
      const c = this.charts[p.plot];
      if (!c) continue;
      if (this.resumed.delete(p.plot) && c.x.length) {
        c.x.push((c.x[c.x.length - 1] + p.t) / 2);
        for (const y of c.y) y.push(null);
      }
      c.x.push(p.t);
      p.y.forEach((v, j) => c.y[j]?.push(v));
      this.latest = Math.max(this.latest, p.t);
    }
    // Drop what has scrolled off (with a margin), so memory stays flat.
    const cut = this.latest - this.windowS - 2;
    for (const c of this.charts) {
      let n = 0;
      while (n < c.x.length && c.x[n] < cut) n++;
      if (n) {
        c.x.splice(0, n);
        for (const y of c.y) y.splice(0, n);
      }
    }
    this.dirty = true;
  }

  clear(): void {
    for (const c of this.charts) {
      c.x.length = 0;
      for (const y of c.y) y.length = 0;
    }
    this.dirty = true;
  }

  points(): number {
    return this.charts.reduce((n, c) => n + c.x.length, 0);
  }
}

/** A downloaded flight: charts that zoom together, with event markers. */
export class FlightPlots {
  private charts: uPlot[] = [];
  private observers: ResizeObserver[] = [];
  shownId = 0;

  render(plot: FlightPlot, boxes: HTMLElement[]): void {
    this.destroy();
    this.shownId = plot.id;
    let syncing = false;
    const markers = (u: uPlot, labels: boolean) => {
      const ctx = u.ctx;
      const { left, top, width, height } = u.bbox;
      ctx.save();
      ctx.strokeStyle = css("--marker");
      ctx.fillStyle = css("--muted");
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = devicePixelRatio;
      ctx.font = `${11 * devicePixelRatio}px ${css("--font")}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      plot.events.forEach(([t, text], n) => {
        const x = Math.round(u.valToPos(t, "x", true));
        if (x < left || x > left + width) return;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + height);
        ctx.stroke();
        // Three rows, so labels of events close together do not overlap.
        if (labels) ctx.fillText(text, x + 4 * devicePixelRatio, top + (4 + 14 * (n % 3)) * devicePixelRatio);
      });
      ctx.restore();
    };
    plot.charts.forEach((chart, i) => {
      const box = boxes[i];
      // Lines in one chart may have different timestamps (IMU vs high-g).
      const data = uPlot.join(chart.lines.map((l) => [l.x, l.y] as uPlot.AlignedData));
      const opts: uPlot.Options = {
        width: box.clientWidth || 600,
        height: box.clientHeight || 160,
        legend: { show: false },
        plugins: [hover(plot.x_label.replace(/\s*\(s\)$/, ""), chart.unit)],
        cursor: { sync: { key: "flight" } },
        scales: { x: { time: false } },
        axes: axes(),
        series: [
          {},
          ...chart.lines.map((l, j) => ({ label: l.name, stroke: css(SERIES[j % SERIES.length]), width: 1.25, spanGaps: true })),
        ],
        hooks: {
          draw: [(u) => markers(u, i === 0)],
          setScale: [
            (u, key) => {
              if (key !== "x" || syncing) return;
              syncing = true;
              const { min, max } = u.scales.x;
              for (const other of this.charts) if (other !== u && min != null && max != null) other.setScale("x", { min, max });
              syncing = false;
            },
          ],
        },
      };
      const u = new uPlot(opts, data, box);
      this.observers.push(fit(u, box));
      this.charts.push(u);
    });
  }

  destroy(): void {
    for (const o of this.observers) o.disconnect();
    for (const c of this.charts) c.destroy();
    this.observers = [];
    this.charts = [];
    this.shownId = 0;
  }
}
