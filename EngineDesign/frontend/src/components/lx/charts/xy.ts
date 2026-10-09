import { nearestIndex } from '../time/search';
import { formatT } from '../time/markers';
import type { TimeStore } from '../time/store';
import { linearTicks } from './axis';
import { ColorResolver, cssColor } from './color';
import { colormapRGB, type ColormapName } from './colormap';
import { contourSegments } from './contour';
import { drawLeader, leaderSvg } from './engine';
import { leaderFor, placeLabels, placeNote, type Box } from './labels';
import { MONO, num, onFontsChange, SANS, textWidth } from './measure';
import { STATUS_TOKEN } from './types';
import { cellEdges, contourLevels, fromPx, heatExtent, toPx, xyScales, type AxisScale } from './xyScale';
import type { XYData, XYSeries } from './xyTypes';

/**
 * The imperative half of `XYChart` and `Heatmap`: one canvas for everything drawn (heat cells,
 * contours, regions, lines, series, marks, the axes and the colourbar) and a DOM layer for the
 * text that must not collide (series and mark names, the worst-point note, limit names, contour
 * values) and for the cursor, which moves by transform without a redraw.
 *
 * It follows the same layout rules as the time charts (engine.ts): the readout row above the
 * plot, starting at its left edge, with the y axis's name and unit heading the tick column; the
 * x axis's name and unit on its last tick; limit names in a right gutter; and, for a heat layer,
 * the colourbar at the far right with its unit heading it on the readout row.
 */

const AXIS_FONT = `11px ${MONO}`;
const LABEL_FONT = `500 11px ${SANS}`;
const UNIT_FONT = `11px ${SANS}`;
const LABEL_H = 14;
const TOP_PAD = 8;
const BOTTOM = 22;
const Y_GAP = 6;
const LABEL_GAP = 8;
const BAR_GAP = 12;
const BAR_W = 10;
const RING = 5;
const TEXT_3 = '--lx-text-3';
/** Hovering this close to a path (px) reads it out (and scrubs the page, for a timed path). */
const HOVER_PX = 28;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.appendChild(e);
  return e;
}

const finite = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);

/** Evenly spaced, to a part in a thousand of the step. */
function uniform(v: readonly number[]): boolean {
  if (v.length < 3) return true;
  const step = (v[v.length - 1] - v[0]) / (v.length - 1);
  if (!(Math.abs(step) > 0)) return false;
  for (let i = 1; i < v.length; i++) if (Math.abs(v[i] - v[i - 1] - step) > 1e-3 * Math.abs(step)) return false;
  return true;
}

interface Frame {
  left: number;
  top: number;
  width: number;
  height: number;
  /** The colourbar's left edge [px], or null. */
  barX: number | null;
  x: AxisScale;
  y: AxisScale;
  zTicks: { ticks: number[]; digits: number } | null;
  zRange: [number, number] | null;
}

export class XYEngine {
  private readonly readout: HTMLElement;
  private readonly plotEl: HTMLElement;
  private data: XYData;
  private store: TimeStore | null;
  private readonly colors: ColorResolver;
  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: HTMLDivElement;
  private readonly cursorEl: HTMLDivElement;
  private readonly hoverEl: HTMLSpanElement;
  private readonly yHead: HTMLSpanElement;
  private readonly zHead: HTMLSpanElement;
  private readonly roText: HTMLSpanElement;
  private readonly leaderEl: SVGSVGElement;
  private readonly leaderLine: SVGLineElement;
  private textEls: HTMLElement[] = [];
  private dotEls: (HTMLSpanElement | null)[] = [];
  private frame: Frame | null = null;
  /** Hovered: a series index and point, or a heat cell's y, or nothing. */
  private hover: { series: number; index: number } | null = null;
  private hoverY: number | null = null;
  private unsubscribe: () => void = () => {};
  private offFonts: () => void;
  private ro: ResizeObserver | null = null;
  private mo: MutationObserver | null = null;
  private frameReq: number | null = null;
  private alive = true;
  private lastT = Number.NaN;

  constructor(root: HTMLElement, readout: HTMLElement, plotEl: HTMLElement, data: XYData, store: TimeStore | null) {
    this.readout = readout;
    this.plotEl = plotEl;
    this.data = data;
    this.store = store;
    this.colors = new ColorResolver(root);
    this.canvas = el('canvas', 'lx-xy-canvas', plotEl);
    this.canvas.setAttribute('aria-hidden', 'true');
    this.overlay = el('div', 'lx-chart-overlay', plotEl);
    this.overlay.setAttribute('aria-hidden', 'true');
    [this.leaderEl, this.leaderLine] = leaderSvg(this.overlay);
    this.cursorEl = el('div', 'lx-chart-cursor lx-xy-cursor', this.overlay);
    this.hoverEl = el('span', 'lx-chart-dot lx-xy-hover', this.overlay);
    this.yHead = el('span', 'lx-chart-unit');
    this.zHead = el('span', 'lx-chart-unit lx-xy-zhead');
    this.roText = el('span', 'lx-chart-ro lx-xy-ro');

    plotEl.addEventListener('pointermove', this.onMove);
    plotEl.addEventListener('pointerdown', this.onMove);
    plotEl.addEventListener('pointerleave', this.onLeave);

    this.subscribe();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.queue());
      this.ro.observe(plotEl);
    }
    const themeHost = root.closest('.lx') ?? document.documentElement;
    this.mo = new MutationObserver(() => {
      this.colors.reset();
      this.queue();
    });
    this.mo.observe(themeHost, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    this.offFonts = onFontsChange(() => this.queue());
    this.draw();
  }

  update(data: XYData): void {
    if (data === this.data) return;
    this.data = data;
    this.hover = null;
    this.draw();
  }

  setStore(store: TimeStore | null): void {
    if (store === this.store) return;
    this.unsubscribe();
    this.store = store;
    this.subscribe();
    this.syncCursor(true);
  }

  destroy(): void {
    this.alive = false;
    this.unsubscribe();
    this.offFonts();
    this.ro?.disconnect();
    this.mo?.disconnect();
    if (this.frameReq !== null) cancelAnimationFrame(this.frameReq);
    this.plotEl.removeEventListener('pointermove', this.onMove);
    this.plotEl.removeEventListener('pointerdown', this.onMove);
    this.plotEl.removeEventListener('pointerleave', this.onLeave);
    this.canvas.remove();
    this.overlay.remove();
    this.colors.destroy();
    this.readout.replaceChildren();
  }

  // ------------------------------------------------------------------ time

  /** Follows the page's clock: a time axis, or a path with times. */
  private timed(): boolean {
    return !!this.data.timeAxis || this.data.series.some((s) => s.t?.length);
  }

  private subscribe(): void {
    if (!this.store || !this.timed()) {
      this.unsubscribe = () => {};
      return;
    }
    this.unsubscribe = this.store.subscribe(() => this.syncCursor(false));
  }

  private queue(): void {
    if (this.frameReq !== null) return;
    this.frameReq = requestAnimationFrame(() => {
      this.frameReq = null;
      if (this.alive) this.draw();
    });
  }

  // ------------------------------------------------------------------ layout

  private yHeadText(): string {
    return [this.data.yName, this.data.yUnit].filter(Boolean).join('\u00a0');
  }

  private layout(W: number, H: number): Frame {
    const d = this.data;
    const heat = d.heat && d.heat.x.length && d.heat.y.length ? d.heat : null;
    const showBar = !!heat && (heat.colorbar ?? heat.fill !== false);
    const zRange = heat ? heatExtent(heat) : null;
    const zTicks = showBar && zRange && zRange[1] > zRange[0]
      ? (() => {
        const t = linearTicks(zRange[0], zRange[1], Math.max(2, Math.min(6, Math.floor((H - TOP_PAD - BOTTOM) / 36))));
        return { ticks: t.ticks, digits: heat?.digits ?? t.digits };
      })()
      : null;
    // The right side: names of horizontal limit lines, then the colourbar and its labels.
    const lineNames = (d.lines ?? []).filter((l) => l.axis === 'y' && l.label).map((l) => textWidth(l.label as string, LABEL_FONT));
    const linesW = lineNames.length ? Math.ceil(Math.max(...lineNames)) + LABEL_GAP + 2 : 0;
    const zLabelW = zTicks ? Math.max(...zTicks.ticks.map((v) => textWidth(num(v, zTicks.digits), AXIS_FONT)), textWidth(heat?.unit ?? '', UNIT_FONT)) : 0;
    const barW = zTicks ? BAR_GAP + BAR_W + 6 + Math.ceil(zLabelW) + 2 : 0;
    const right = Math.max(10, linesW + barW);

    // Two passes: the y labels' width depends on the y ticks, which depend on the height only.
    let left = 40;
    let s = xyScales(d, W - left - right, H - TOP_PAD - BOTTOM);
    const yw = Math.max(...s.y.labels.map((l) => textWidth(l, AXIS_FONT)), textWidth(this.yHeadText(), UNIT_FONT), 8);
    left = Math.ceil(yw) + Y_GAP + 6;
    s = xyScales(d, W - left - right, H - TOP_PAD - BOTTOM);
    const width = Math.max(20, W - left - right);
    const height = Math.max(20, H - TOP_PAD - BOTTOM);
    return {
      left, top: TOP_PAD, width, height,
      barX: zTicks ? left + width + linesW + BAR_GAP : null,
      x: s.x, y: s.y, zTicks, zRange,
    };
  }

  private px(f: Frame, x: number, y: number): [number, number] {
    return [toPx(f.x, x, f.left, f.left + f.width), toPx(f.y, y, f.top + f.height, f.top)];
  }

  // ------------------------------------------------------------------ draw

  private draw(): void {
    const W = Math.max(60, Math.floor(this.plotEl.clientWidth));
    const H = Math.max(60, Math.floor(this.plotEl.clientHeight));
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const d = this.data;
    const f = this.layout(W, H);
    this.frame = f;
    const cv = this.canvas;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    cv.style.width = `${W}px`;
    cv.style.height = `${H}px`;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const col = (c: string) => this.colors.get(c);
    const { left, top, width, height } = f;
    const heat = d.heat && d.heat.x.length && d.heat.y.length ? d.heat : null;
    const filled = !!heat && heat.fill !== false;

    // Grid (under a filled heat layer it would be hidden; there the ticks alone mark the axes).
    if (!filled) {
      ctx.strokeStyle = col('--lx-line');
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const v of f.x.ticks) {
        const x = Math.round(toPx(f.x, v, left, left + width)) + 0.5;
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + height);
      }
      for (const v of f.y.ticks) {
        const y = Math.round(toPx(f.y, v, top + height, top)) + 0.5;
        ctx.moveTo(left, y);
        ctx.lineTo(left + width, y);
      }
      ctx.stroke();
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, width, height);
    ctx.clip();

    // Heat cells: a uniform grid as one image, smoothed between the grid points (each pixel of the
    // image is a grid point, centred in its cell, so the layout is the cells'); an uneven grid as
    // one rectangle per cell.
    if (heat && filled && f.zRange && uniform(heat.x) && uniform(heat.y) && heat.x.length > 1 && heat.y.length > 1) {
      const cmap: ColormapName = heat.colormap ?? 'viridis';
      const nx = heat.x.length;
      const ny = heat.y.length;
      const img = new ImageData(nx, ny);
      const [z0, z1] = f.zRange;
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < ny; j++) {
          const v = heat.z[i]?.[j];
          // Rows top-down: y ascends upwards.
          const o = 4 * ((ny - 1 - j) * nx + i);
          if (!finite(v)) continue;
          const [r, g, b] = colormapRGB(cmap, (v - z0) / (z1 - z0 || 1));
          img.data[o] = r;
          img.data[o + 1] = g;
          img.data[o + 2] = b;
          img.data[o + 3] = 255;
        }
      }
      const off = document.createElement('canvas');
      off.width = nx;
      off.height = ny;
      off.getContext('2d')?.putImageData(img, 0, 0);
      const ex = cellEdges(heat.x);
      const ey = cellEdges(heat.y);
      const x0 = toPx(f.x, ex[0], left, left + width);
      const x1 = toPx(f.x, ex[ex.length - 1], left, left + width);
      const y0 = toPx(f.y, ey[ey.length - 1], top + height, top);
      const y1 = toPx(f.y, ey[0], top + height, top);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(off, Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    } else if (heat && filled && f.zRange) {
      const cmap: ColormapName = heat.colormap ?? 'viridis';
      const ex = cellEdges(heat.x).map((v) => toPx(f.x, v, left, left + width));
      const ey = cellEdges(heat.y).map((v) => toPx(f.y, v, top + height, top));
      const [z0, z1] = f.zRange;
      for (let i = 0; i < heat.x.length; i++) {
        const colz = heat.z[i];
        if (!colz) continue;
        const xa = Math.floor(Math.min(ex[i], ex[i + 1]));
        const xb = Math.ceil(Math.max(ex[i], ex[i + 1]));
        for (let j = 0; j < heat.y.length; j++) {
          const v = colz[j];
          if (!finite(v)) continue;
          const [r, g, b] = colormapRGB(cmap, (v - z0) / (z1 - z0 || 1));
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          const ya = Math.floor(Math.min(ey[j], ey[j + 1]));
          const yb = Math.ceil(Math.max(ey[j], ey[j + 1]));
          ctx.fillRect(xa, ya, xb - xa, yb - ya);
        }
      }
    }

    // Regions: faint status washes with a hairline edge.
    for (const r of d.regions ?? []) {
      if (r.points.length < 3) continue;
      ctx.beginPath();
      r.points.forEach(([x, y], k) => {
        const [px, py] = this.px(f, x, y);
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = col(STATUS_TOKEN[r.status]);
      ctx.fill();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = col(STATUS_TOKEN[r.status]);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Contours: thin lines in the surface colour over a filled layer, the label grey without one.
    const contourLabels: { text: string; x: number; y: number }[] = [];
    if (heat) {
      const levels = contourLevels(heat);
      const digits = heat.digits ?? (levels.length > 1 ? Math.max(0, -Math.floor(Math.log10(Math.abs(levels[1] - levels[0])) + 1e-9)) : 0);
      ctx.strokeStyle = col(filled ? '--lx-surface' : TEXT_3);
      ctx.globalAlpha = filled ? 0.75 : 0.9;
      ctx.lineWidth = 1;
      for (const level of levels) {
        const segs = contourSegments(heat.x, heat.y, heat.z, level);
        if (!segs.length) continue;
        ctx.beginPath();
        let best: { x: number; y: number; score: number } | null = null;
        for (const [x0, y0, x1, y1] of segs) {
          const [a, b] = this.px(f, x0, y0);
          const [c, e] = this.px(f, x1, y1);
          ctx.moveTo(a, b);
          ctx.lineTo(c, e);
          // Label where the line runs furthest right and up, away from the axes.
          const mx = (a + c) / 2;
          const my = (b + e) / 2;
          const score = mx - 0.3 * my;
          if (mx > left + 14 && mx < left + width - 14 && my > top + 8 && my < top + height - 8 && (!best || score > best.score)) best = { x: mx, y: my, score };
        }
        ctx.stroke();
        if (best) contourLabels.push({ text: num(level, digits), x: best.x, y: best.y });
      }
      ctx.globalAlpha = 1;
    }

    // Limit lines.
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    for (const l of d.lines ?? []) {
      ctx.strokeStyle = col(STATUS_TOKEN[l.status]);
      ctx.beginPath();
      if (l.axis === 'y') {
        const y = Math.round(toPx(f.y, l.value, top + height, top)) + 0.5;
        ctx.moveTo(left, y);
        ctx.lineTo(left + width, y);
      } else {
        const x = Math.round(toPx(f.x, l.value, left, left + width)) + 0.5;
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + height);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Series: ghosts under the rest.
    const order = d.series.map((_, i) => i).sort((a, b) => Number(!!d.series[b].ghost) - Number(!!d.series[a].ghost));
    for (const i of order) this.drawSeries(ctx, f, d.series[i]);

    // Marks.
    for (const m of d.marks ?? []) {
      const [x, y] = this.px(f, m.x, m.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const c = col(m.color ?? '--lx-text');
      ctx.strokeStyle = c;
      ctx.fillStyle = c;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      switch (m.shape ?? 'dot') {
        case 'cross':
          ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4);
          ctx.stroke();
          break;
        case 'diamond':
          ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.closePath();
          ctx.fill();
          break;
        case 'ring':
          ctx.arc(x, y, 4, 0, Math.PI * 2);
          ctx.stroke();
          break;
        default:
          ctx.arc(x, y, 3.5, 0, Math.PI * 2);
          ctx.fill();
      }
    }

    // The worst point: a ring.
    const worst = this.worstPx(f);
    if (worst) {
      ctx.strokeStyle = col('--lx-text');
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(worst.x, worst.y, RING, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Event ticks on a time axis.
    if (d.timeAxis === 'x' && d.events?.length) {
      ctx.strokeStyle = col(TEXT_3);
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      for (const e of d.events) {
        const x = Math.round(toPx(f.x, e.t, left, left + width)) + 0.5;
        if (x < left || x > left + width) continue;
        ctx.moveTo(x, top + height);
        ctx.lineTo(x, top + height - 6);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    this.drawAxes(ctx, f, W);
    this.layoutText(f, contourLabels, worst);
    this.buildReadout(f);
    this.syncCursor(true);
  }

  private drawSeries(ctx: CanvasRenderingContext2D, f: Frame, s: XYSeries): void {
    const n = Math.min(s.x.length, s.y.length);
    ctx.strokeStyle = this.colors.get(s.ghost ? TEXT_3 : s.color);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.globalAlpha = s.ghost ? 0.7 : 1;
    ctx.lineWidth = s.ghost ? 1 : (s.width ?? 1.5);
    ctx.setLineDash(s.dash ?? []);
    ctx.lineJoin = 'round';
    if (s.points) {
      for (let i = 0; i < n; i++) {
        const x = s.x[i];
        const y = s.y[i];
        if (!finite(x) || !finite(y)) continue;
        const [px, py] = this.px(f, x, y);
        ctx.beginPath();
        ctx.arc(px, py, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < n; i++) {
        const x = s.x[i];
        const y = s.y[i];
        const [px, py] = finite(x) && finite(y) ? this.px(f, x, y) : [Number.NaN, Number.NaN];
        if (!Number.isFinite(px) || !Number.isFinite(py)) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
        pen = true;
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  private drawAxes(ctx: CanvasRenderingContext2D, f: Frame, W: number): void {
    const { left, top, width, height } = f;
    ctx.font = AXIS_FONT;
    ctx.fillStyle = this.colors.get(TEXT_3);
    ctx.textBaseline = 'top';
    // x labels: centred under their tick, the first and last kept inside the canvas.
    f.x.ticks.forEach((v, k) => {
      const x = toPx(f.x, v, left, left + width);
      const text = f.x.labels[k];
      const w = textWidth(text, AXIS_FONT);
      const lx = Math.min(Math.max(x - w / 2, 0), W - w);
      ctx.textAlign = 'left';
      ctx.fillText(text, lx, top + height + 5);
    });
    // y labels: right-aligned against the plot.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    f.y.ticks.forEach((v, k) => ctx.fillText(f.y.labels[k], left - Y_GAP, toPx(f.y, v, top + height, top)));

    // The colourbar: high at the top, its ticks to the right.
    const heat = this.data.heat;
    if (f.barX !== null && f.zTicks && f.zRange && heat) {
      const cmap: ColormapName = heat.colormap ?? 'viridis';
      const g = ctx.createLinearGradient(0, top + height, 0, top);
      for (let k = 0; k <= 10; k++) {
        const [r, gg, b] = colormapRGB(cmap, k / 10);
        g.addColorStop(k / 10, `rgb(${r},${gg},${b})`);
      }
      ctx.fillStyle = g;
      ctx.fillRect(f.barX, top, BAR_W, height);
      ctx.fillStyle = this.colors.get(TEXT_3);
      ctx.textAlign = 'left';
      const [z0, z1] = f.zRange;
      for (const v of f.zTicks.ticks) {
        const y = top + height - ((v - z0) / (z1 - z0 || 1)) * height;
        if (y < top - 1 || y > top + height + 1) continue;
        ctx.fillText(num(v, f.zTicks.digits), f.barX + BAR_W + 6, Math.min(Math.max(y, top + 6), top + height - 6));
        ctx.fillRect(f.barX + BAR_W, Math.round(y) - 0.5, 3, 1);
      }
    }
  }

  private worstPx(f: Frame): { x: number; y: number } | null {
    const w = this.data.worst;
    if (!w) return null;
    const s = this.data.series.find((x) => x.key === w.seriesKey);
    const x = s?.x[w.index];
    const y = s?.y[w.index];
    if (!finite(x) || !finite(y)) return null;
    const [px, py] = this.px(f, x, y);
    return Number.isFinite(px) && Number.isFinite(py) ? { x: px, y: py } : null;
  }

  /** Every drawn line in px, thinned to about a point per pixel. */
  private polylines(f: Frame): number[][] {
    const out: number[][] = [];
    for (const s of this.data.series) {
      let line: number[] = [];
      let last: [number, number] | null = null;
      const n = Math.min(s.x.length, s.y.length);
      for (let i = 0; i < n; i++) {
        const x = s.x[i];
        const y = s.y[i];
        const p = finite(x) && finite(y) ? this.px(f, x, y) : null;
        if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
          if (line.length >= 4) out.push(line);
          line = [];
          last = null;
          continue;
        }
        if (last && Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 1 && i < n - 1) continue;
        line.push(p[0], p[1]);
        last = p;
      }
      if (line.length >= 4) out.push(line);
    }
    return out;
  }

  // ------------------------------------------------------------------ text

  private layoutText(f: Frame, contourLabels: { text: string; x: number; y: number }[], worst: { x: number; y: number } | null): void {
    for (const e of this.textEls) e.remove();
    this.textEls = [];
    for (const e of this.dotEls) e?.remove();
    const d = this.data;
    const { left, top, width, height } = f;
    const bounds: Box = { x: left + 1, y: top + 1, w: width - 2, h: height - 2 };
    const lines = this.polylines(f);
    const hlines = (d.lines ?? []).filter((l) => l.axis === 'y').map((l) => toPx(f.y, l.value, top + height, top));
    const vlines = (d.lines ?? []).filter((l) => l.axis === 'x').map((l) => toPx(f.x, l.value, left, left + width));
    const taken: Box[] = [];
    const text = (cls: string, s: string, color?: string) => {
      const e = el('span', cls, this.overlay);
      e.textContent = s;
      if (color) e.style.color = color;
      this.textEls.push(e);
      return e;
    };
    const place = (e: HTMLElement, anchor: { x: number; y: number }, ring: number) => {
      const size = { w: e.offsetWidth || textWidth(e.textContent ?? '', LABEL_FONT) + 6, h: e.offsetHeight || LABEL_H };
      const b = placeNote(anchor, size, bounds, { polylines: lines, hlines, vlines, boxes: taken }, ring);
      taken.push(b);
      e.style.transform = `translate(${Math.round(b.x)}px, ${Math.round(b.y)}px)`;
      return b;
    };

    // The worst point's note first: it matters most.
    if (worst && d.worst?.text) {
      const b = place(text('lx-chart-anno lx-num', d.worst.text), worst, RING);
      drawLeader(this.leaderEl, this.leaderLine, leaderFor(worst, b, RING));
    } else {
      drawLeader(this.leaderEl, this.leaderLine, null);
    }

    // Marks' names beside them.
    for (const m of d.marks ?? []) {
      if (!m.label) continue;
      const [x, y] = this.px(f, m.x, m.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      taken.push({ x: x - 5, y: y - 5, w: 10, h: 10 });
      place(text('lx-chart-label lx-xy-pill lx-xy-mark', m.label, m.color ? cssColor(m.color) : undefined), { x, y }, 5);
    }

    // Series' names beside their last point.
    for (const s of d.series) {
      if (!s.label) continue;
      let i = Math.min(s.x.length, s.y.length) - 1;
      while (i >= 0 && !(finite(s.x[i]) && finite(s.y[i]))) i--;
      if (i < 0) continue;
      const [x, y] = this.px(f, s.x[i] as number, s.y[i] as number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      place(text(`lx-chart-label lx-xy-pill${s.ghost ? ' lx-chart-label-ghost' : ''}`, s.label, s.ghost ? `var(${TEXT_3})` : cssColor(s.color)), { x, y }, 3);
    }

    // Regions' names at their centroid.
    for (const r of d.regions ?? []) {
      if (!r.label || r.points.length < 3) continue;
      const cx = r.points.reduce((a, p) => a + p[0], 0) / r.points.length;
      const cy = r.points.reduce((a, p) => a + p[1], 0) / r.points.length;
      const [x, y] = this.px(f, cx, cy);
      const e = text(`lx-chart-label lx-xy-pill lx-chart-limit lx-chart-limit-${r.status}`, r.label);
      place(e, { x, y }, 0);
    }

    // Horizontal limit names in the right gutter, nudged apart; vertical ones at the top.
    const items = (d.lines ?? []).flatMap((l, k) => (l.axis === 'y' && l.label ? [{ key: String(k), y: toPx(f.y, l.value, top + height, top), h: LABEL_H }] : []));
    const placed = placeLabels(items, top, top + height, 2);
    (d.lines ?? []).forEach((l, k) => {
      if (!l.label) return;
      const e = text(`lx-chart-label lx-chart-limit lx-chart-limit-${l.status}${l.axis === 'x' ? ' lx-xy-pill' : ''}`, l.label);
      if (l.axis === 'y') {
        const y = placed.get(String(k));
        if (y === undefined) {
          e.remove();
          return;
        }
        e.style.transform = `translate(${left + width + LABEL_GAP}px, ${y - LABEL_H / 2}px)`;
      } else {
        const x = toPx(f.x, l.value, left, left + width);
        const w = e.offsetWidth || textWidth(l.label, LABEL_FONT);
        const lx = x + 4 + w <= left + width ? x + 4 : x - 4 - w;
        taken.push({ x: lx, y: top + 2, w, h: e.offsetHeight || LABEL_H });
        e.style.transform = `translate(${Math.round(lx)}px, ${top + 2}px)`;
      }
    });

    // Contour values, where they land clear of the text above.
    for (const c of contourLabels) {
      const e = text('lx-xy-contour lx-xy-pill lx-num', c.text);
      const w = e.offsetWidth || textWidth(c.text, AXIS_FONT) + 4;
      const h = e.offsetHeight || 13;
      const b: Box = { x: c.x - w / 2, y: c.y - h / 2, w, h };
      if (taken.some((t) => b.x < t.x + t.w + 2 && t.x < b.x + b.w + 2 && b.y < t.y + t.h + 2 && t.y < b.y + b.h + 2)) {
        e.remove();
        continue;
      }
      taken.push(b);
      e.style.transform = `translate(${Math.round(b.x)}px, ${Math.round(b.y)}px)`;
    }

    // Cursor dots for the timed paths.
    this.dotEls = d.series.map((s) => {
      if (!s.t?.length) return null;
      const e = el('span', `lx-chart-dot${s.ghost ? ' lx-chart-dot-ghost' : ''}`, this.overlay);
      e.style.backgroundColor = s.ghost ? `var(${TEXT_3})` : cssColor(s.color);
      return e;
    });
  }

  // ------------------------------------------------------------------ readout

  private buildReadout(f: Frame): void {
    const d = this.data;
    this.readout.replaceChildren();
    this.yHead.textContent = this.yHeadText();
    this.readout.appendChild(this.yHead);
    this.readout.style.paddingLeft = `${Math.round(f.left)}px`;
    this.yHead.style.width = `${Math.max(0, Math.round(f.left - Y_GAP))}px`;
    this.readout.appendChild(this.roText);
    if (f.barX !== null && d.heat) {
      this.zHead.textContent = d.heat.unit;
      this.zHead.style.left = `${Math.round(f.barX)}px`;
      this.zHead.style.width = 'auto';
      this.zHead.style.textAlign = 'left';
      this.readout.appendChild(this.zHead);
      this.readout.style.paddingRight = `${Math.round(this.plotEl.clientWidth - f.barX + 4)}px`;
    } else {
      this.readout.style.paddingRight = '';
    }
  }

  /** The readout: what the cursor or the pointer is on. */
  private writeReadout(): void {
    const f = this.frame;
    const d = this.data;
    if (!f) return;
    const parts: { label?: string; color?: string; ghost?: boolean; values: [string, string][] }[] = [];
    const xd = d.xDigits ?? Math.min(3, f.x.digits + 1);
    const yd = d.yDigits ?? Math.min(3, f.y.digits + 1);
    const xName = d.xName ?? 'x';
    const yName = d.yName ?? 'y';
    const heat = d.heat && d.heat.x.length && d.heat.y.length ? d.heat : null;
    const t = this.store?.get().t;

    if (heat && d.timeAxis && t !== undefined && Number.isFinite(t)) {
      // The column (or row) under the cursor: the hovered cell, else the peak along it.
      const along = d.timeAxis === 'x' ? heat.x : heat.y;
      const across = d.timeAxis === 'x' ? heat.y : heat.x;
      const it = nearestIndex(along, t);
      const zAt = (j: number) => (d.timeAxis === 'x' ? heat.z[it]?.[j] : heat.z[j]?.[it]);
      let j = -1;
      if (this.hoverY !== null) j = nearestIndex(across, this.hoverY);
      else {
        let best = -Infinity;
        for (let k = 0; k < across.length; k++) {
          const v = zAt(k);
          if (finite(v) && v > best) {
            best = v;
            j = k;
          }
        }
      }
      const zd = heat.digits ?? (f.zTicks ? Math.min(3, f.zTicks.digits + 1) : 2);
      const z = j >= 0 ? zAt(j) : null;
      const where = d.timeAxis === 'x' ? [yName, d.yUnit] : [xName, d.xUnit];
      parts.push({ values: [[formatT(along[it]), '']] });
      parts.push({
        label: this.hoverY === null ? `peak ${heat.name ?? ''}`.trim() : heat.name ?? '',
        values: [[finite(z) ? num(z, zd) : '—', heat.unit], [j >= 0 ? `at ${num(across[j], d.timeAxis === 'x' ? f.y.digits : f.x.digits)}` : '', where[1] ?? '']],
      });
    }

    d.series.forEach((s, k) => {
      let i = -1;
      if (this.hover && this.hover.series === k) i = this.hover.index;
      else if (s.t?.length && t !== undefined && !this.hover) i = nearestIndex(s.t, t);
      if (i < 0) return;
      const x = s.x[i];
      const y = s.y[i];
      const values: [string, string][] = [[`${xName}\u00a0${finite(x) ? num(x, xd) : '—'}`, d.xUnit], [`${yName}\u00a0${finite(y) ? num(y, yd) : '—'}`, d.yUnit]];
      const m = s.meta?.[i];
      if (finite(m)) values.push([num(m, Math.max(0, 2 - Math.floor(Math.log10(Math.abs(m) || 1)))), s.metaUnit ?? '']);
      parts.push({ label: s.label || (s.ghost ? 'vs' : ''), color: s.ghost ? `var(${TEXT_3})` : cssColor(s.color), ghost: s.ghost, values });
    });

    const ro = this.roText;
    ro.replaceChildren();
    for (const p of parts) {
      const item = el('span', `lx-chart-ro${p.ghost ? ' lx-chart-ro-ghost' : ''}`, ro);
      if (p.color) {
        const key = el('i', 'lx-chart-ro-key', item);
        key.style.borderTopColor = p.color;
      }
      if (p.label) el('span', 'lx-chart-ro-label', item).textContent = p.label;
      for (const [v, unit] of p.values) {
        if (!v) continue;
        el('span', 'lx-chart-ro-value lx-num', item).textContent = v;
        if (unit) el('span', 'lx-xy-ro-unit', item).textContent = unit;
      }
    }

  }

  // ------------------------------------------------------------------ cursor

  private syncCursor(force: boolean): void {
    const f = this.frame;
    const d = this.data;
    if (!f) return;
    const t = this.store?.get().t ?? Number.NaN;
    if (!force && t === this.lastT) return;
    this.lastT = t;
    const timed = this.timed() && Number.isFinite(t);
    if (d.timeAxis && timed) {
      const inX = d.timeAxis === 'x';
      const p = inX ? toPx(f.x, t, f.left, f.left + f.width) : toPx(f.y, t, f.top + f.height, f.top);
      const inside = inX ? p >= f.left - 0.5 && p <= f.left + f.width + 0.5 : p >= f.top - 0.5 && p <= f.top + f.height + 0.5;
      this.cursorEl.style.display = inside ? '' : 'none';
      this.cursorEl.classList.toggle('lx-xy-cursor-h', !inX);
      this.cursorEl.style.top = inX ? `${f.top}px` : '0px';
      this.cursorEl.style.height = inX ? `${f.height}px` : '1px';
      this.cursorEl.style.left = inX ? '-0.5px' : `${f.left}px`;
      this.cursorEl.style.width = inX ? '1px' : `${f.width}px`;
      this.cursorEl.style.bottom = 'auto';
      this.cursorEl.style.transform = inX ? `translateX(${p}px)` : `translateY(${p}px)`;
    } else {
      this.cursorEl.style.display = 'none';
    }
    d.series.forEach((s, k) => {
      const dot = this.dotEls[k];
      if (!dot) return;
      if (!s.t?.length || !timed || t < s.t[0] || t > s.t[s.t.length - 1]) {
        dot.style.display = 'none';
        return;
      }
      const i = nearestIndex(s.t, t);
      const x = s.x[i];
      const y = s.y[i];
      if (!finite(x) || !finite(y)) {
        dot.style.display = 'none';
        return;
      }
      const [px, py] = this.px(f, x, y);
      dot.style.display = '';
      dot.style.transform = `translate(${px}px, ${py}px)`;
    });
    this.writeReadout();
  }

  // ------------------------------------------------------------------ input

  private onMove = (e: PointerEvent): void => {
    const f = this.frame;
    if (!f) return;
    const rect = this.plotEl.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const inside = mx >= f.left && mx <= f.left + f.width && my >= f.top && my <= f.top + f.height;
    const d = this.data;
    if (!inside) {
      this.onLeave();
      return;
    }
    if (d.timeAxis) {
      const inX = d.timeAxis === 'x';
      const t = inX ? fromPx(f.x, mx, f.left, f.left + f.width) : fromPx(f.y, my, f.top + f.height, f.top);
      this.hoverY = inX ? fromPx(f.y, my, f.top + f.height, f.top) : fromPx(f.x, mx, f.left, f.left + f.width);
      if (this.store && !this.store.get().playing) this.store.setT(t);
      else this.writeReadout();
      return;
    }
    // Nearest drawn point within reach.
    let best: { series: number; index: number; d2: number } | null = null;
    d.series.forEach((s, k) => {
      const n = Math.min(s.x.length, s.y.length);
      for (let i = 0; i < n; i++) {
        const x = s.x[i];
        const y = s.y[i];
        if (!finite(x) || !finite(y)) continue;
        const [px, py] = this.px(f, x, y);
        const d2 = (px - mx) ** 2 + (py - my) ** 2;
        if (d2 <= HOVER_PX * HOVER_PX && (!best || d2 < best.d2)) best = { series: k, index: i, d2 };
      }
    });
    const hit = best as { series: number; index: number; d2: number } | null;
    if (!hit) {
      this.onLeave();
      return;
    }
    const s = d.series[hit.series];
    // A timed path: the pointer scrubs the page to that point's time.
    if (s.t?.length && this.store && !this.store.get().playing) {
      this.hover = null;
      this.hoverEl.style.display = 'none';
      this.store.setT(s.t[hit.index]);
      return;
    }
    this.hover = { series: hit.series, index: hit.index };
    const [px, py] = this.px(f, s.x[hit.index] as number, s.y[hit.index] as number);
    this.hoverEl.style.display = '';
    this.hoverEl.style.backgroundColor = s.ghost ? `var(${TEXT_3})` : cssColor(s.color);
    this.hoverEl.style.transform = `translate(${px}px, ${py}px)`;
    this.writeReadout();
  };

  private onLeave = (): void => {
    if (this.hover === null && this.hoverY === null) return;
    this.hover = null;
    this.hoverY = null;
    this.hoverEl.style.display = 'none';
    this.writeReadout();
  };
}
