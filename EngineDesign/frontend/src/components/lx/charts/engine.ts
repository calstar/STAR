import uPlot from 'uplot';
import { nearestIndex } from '../time/search';
import { createTimeStore, FOCUS_MS, type TimeStore } from '../time/store';
import { linearTicks, logTicks, spanRange, timeTicks, xTickLabels } from './axis';
import { ColorResolver, cssColor } from './color';
import { leaderFor, placeLabels, placeNote, type Box } from './labels';
import { MONO, num, onFontsChange, SANS, textWidth } from './measure';
import { extent, niceRange, tickCount, yScaleFor, type NiceRange } from './scale';
import { STATUS_TOKEN, type ChartBand, type ChartData } from './types';

/**
 * The imperative half of `Chart`: a uPlot canvas for the lines, the grid and the static marks,
 * and a thin DOM layer for the text (direct labels, limit labels, the worst-point note) and the
 * cursor. The cursor follows the TimeStore by subscription and moves with a transform; the plot
 * is never rebuilt or redrawn for it, so scrubbing costs a binary search and a few style writes
 * per chart per frame.
 *
 * Layout, one rule for every chart:
 *   - the readout row sits above the plot, aligned with the plot's left edge; the y unit heads
 *     the tick column on that row (so it can never touch a tick label);
 *   - series and limit lines are named in a right gutter, nudged apart together;
 *   - the x unit rides on the last x tick.
 */

const AXIS_FONT = `11px ${MONO}`;
const LABEL_FONT = `500 11px ${SANS}`;
const UNIT_FONT = `11px ${SANS}`;
/** Direct label box height [px]. */
const LABEL_H = 14;
/** Space between the plot's right edge and a gutter label [px]. */
const LABEL_GAP = 8;
/** A gutter label is cut (with an ellipsis) past this share of the chart's width. */
const LABEL_MAX_SHARE = 0.28;
/** Room above the top gridline for half a tick label [px]. */
const TOP_PAD = 8;
/** Gap between the y tick labels and the plot [px]. */
const Y_GAP = 6;
/** The worst point's ring radius [px]. */
const RING = 5;
const TEXT_3 = '--lx-text-3';

function lastFinite(values: readonly (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) return v;
  }
  return null;
}

const isLog = (d: ChartData) => !!d.xLog;
/** On the burn's clock (the page cursor), or an axis of its own. */
export const isTimeAxis = (d: Pick<ChartData, 'xTime' | 'xLog'>) => d.xTime !== false && !d.xLog;

/** Everything about the chart that needs a new plot when it changes (not the values). */
function structureOf(d: ChartData): string {
  return JSON.stringify([d.yUnit, d.xLabel ?? 's', !!d.xLog, isTimeAxis(d),
    d.series.map((s) => [s.key, s.label, s.color, s.dash ?? null, s.width ?? null, !!s.ghost])]);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.appendChild(e);
  return e;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A hairline layer for the worst point's leader, under the text. */
export function leaderSvg(parent: HTMLElement): [SVGSVGElement, SVGLineElement] {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'lx-chart-leader');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(SVG_NS, 'line');
  svg.appendChild(line);
  parent.insertBefore(svg, parent.firstChild);
  return [svg, line];
}

export function drawLeader(svg: SVGSVGElement, line: SVGLineElement, seg: [number, number, number, number] | null): void {
  svg.style.display = seg ? '' : 'none';
  if (!seg) return;
  line.setAttribute('x1', seg[0].toFixed(1));
  line.setAttribute('y1', seg[1].toFixed(1));
  line.setAttribute('x2', seg[2].toFixed(1));
  line.setAttribute('y2', seg[3].toFixed(1));
}

/** An x value in the readout of a chart not on the clock: three significant figures. */
function xText(v: number, unit: string): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const digits = a === 0 ? 0 : Math.max(0, Math.min(4, 2 - Math.floor(Math.log10(a))));
  return `${num(v, digits)}${unit ? `\u00a0${unit}` : ''}`;
}

export class ChartEngine {
  private readonly readout: HTMLElement;
  private readonly plotEl: HTMLElement;
  private data: ChartData;
  private store: TimeStore;
  private ownStore: TimeStore | null = null;
  private u: uPlot | null = null;
  private readonly colors: ColorResolver;
  private structure = '';
  /** uPlot's series order (ghosts first, under the rest) as indices into `data.series`. */
  private order: number[] = [];
  private yr: NiceRange = niceRange(0, 1);
  private digits = 0;
  private xDigits = 0;

  private readonly overlay: HTMLDivElement;
  private readonly unitEl: HTMLSpanElement;
  private readonly annoEl: HTMLSpanElement;
  private readonly leaderEl: SVGSVGElement;
  private readonly leaderLine: SVGLineElement;
  private readonly emptyEl: HTMLDivElement;
  private labelEls: (HTMLSpanElement | null)[] = [];
  private limitEls: HTMLSpanElement[] = [];
  private valueEls: HTMLSpanElement[] = [];
  private xValueEl: HTMLSpanElement | null = null;
  private cursorEl: HTMLDivElement | null = null;
  private dotEls: (HTMLSpanElement | null)[] = [];
  private focusEl: HTMLElement | null = null;
  private focusTimer: number | null = null;

  private lastIdx = -2;
  /** The page span the x scale was last fitted to (see sharedRange). */
  private lastRange: readonly [number, number] | null = null;
  /** The cursor's x when it stands where this chart has no sample (NaN: not shown). */
  private lastBareX = NaN;
  private lastFocusSeq = -1;
  private unsubscribe: () => void = () => {};
  private ro: ResizeObserver | null = null;
  private mo: MutationObserver | null = null;
  private resizeFrame: number | null = null;
  private alive = true;
  private pressed = false;
  private offFonts: () => void = () => {};

  constructor(root: HTMLElement, readout: HTMLElement, plotEl: HTMLElement, data: ChartData, store: TimeStore | null) {
    this.readout = readout;
    this.plotEl = plotEl;
    this.data = data;
    this.colors = new ColorResolver(root);
    this.store = this.pickStore(isTimeAxis(data) ? store : null);

    this.overlay = el('div', 'lx-chart-overlay', plotEl);
    this.overlay.setAttribute('aria-hidden', 'true');
    this.unitEl = el('span', 'lx-chart-unit');
    this.annoEl = el('span', 'lx-chart-anno lx-num', this.overlay);
    [this.leaderEl, this.leaderLine] = leaderSvg(this.overlay);
    this.emptyEl = el('div', 'lx-chart-empty', plotEl);
    this.emptyEl.textContent = 'Not computed for this run';

    this.rebuild();
    this.subscribe();

    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.queueResize());
      this.ro.observe(plotEl);
    }
    // The theme lives on the closest Layer X root; colours are re-read when it flips.
    const themeHost = root.closest('.lx') ?? document.documentElement;
    this.mo = new MutationObserver(() => this.retheme());
    this.mo.observe(themeHost, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    // Text measured before the bundled fonts arrive is the fallback's: the gutters and the axis
    // sizes are measured again once they have.
    this.offFonts = onFontsChange(() => {
      if (this.alive) this.u?.redraw(false, true);
    });
  }

  // ------------------------------------------------------------------ public

  update(data: ChartData): void {
    if (data === this.data) return;
    const prev = this.data;
    this.data = data;
    this.ownStore?.setSeries(data.t);
    if (structureOf(data) !== this.structure || (prev.t.length === 0) !== (data.t.length === 0)) {
      this.rebuild();
      return;
    }
    this.computeRange();
    this.writeReadoutWidths();
    if (this.u) {
      this.u.setData(this.aligned(), true);
      // Labels may have changed length: the gutters are measured again.
      this.u.redraw(false, true);
      this.syncCursor(true);
    } else {
      this.rebuild();
    }
  }

  setStore(store: TimeStore | null): void {
    const next = isTimeAxis(this.data) ? store : null;
    if (next === this.store || (next === null && this.ownStore === this.store)) return;
    this.unsubscribe();
    this.store = this.pickStore(next);
    this.subscribe();
    // Following the page or not changes the span the x axis is fitted to.
    if (this.u) {
      this.u.setData(this.aligned(), true);
      this.u.redraw(false, true);
    }
    this.syncCursor(true);
  }

  destroy(): void {
    this.alive = false;
    this.unsubscribe();
    this.offFonts();
    this.ro?.disconnect();
    this.mo?.disconnect();
    if (this.resizeFrame !== null) cancelAnimationFrame(this.resizeFrame);
    if (this.focusTimer !== null) clearTimeout(this.focusTimer);
    this.destroyPlot();
    this.colors.destroy();
    this.overlay.remove();
    this.emptyEl.remove();
    this.readout.replaceChildren();
    this.ownStore?.destroy();
  }

  // ------------------------------------------------------------------ store

  private pickStore(store: TimeStore | null): TimeStore {
    if (store) return store;
    // Outside a Burn page, or on an axis that is not the clock, the chart has a cursor of its own.
    if (!this.ownStore) {
      this.ownStore = createTimeStore();
      this.ownStore.setSeries(this.data.t);
      this.ownStore.setT(this.data.t[0] ?? 0);
      this.ownStore.flush();
    }
    return this.ownStore;
  }

  private subscribe(): void {
    this.lastRange = this.sharedRange();
    this.unsubscribe = this.store.subscribe(() => {
      const range = this.sharedRange();
      if (range?.[0] !== this.lastRange?.[0] || range?.[1] !== this.lastRange?.[1]) {
        // A new run's span.
        this.lastRange = range;
        if (this.u) {
          this.u.setData(this.aligned(), true);
          this.u.redraw(false, true);
          this.syncCursor(true);
        }
      }
      this.syncCursor(false);
      this.syncFocus();
    });
  }

  // ------------------------------------------------------------------ build

  private rebuild(): void {
    this.destroyPlot();
    this.structure = structureOf(this.data);
    const d = this.data;
    if (!isTimeAxis(d) && this.store !== this.ownStore) {
      this.unsubscribe();
      this.store = this.pickStore(null);
      this.subscribe();
    }
    this.order = d.series.map((_, i) => i).sort((a, b) => Number(!!d.series[b].ghost) - Number(!!d.series[a].ghost));
    this.buildReadout();
    this.buildLabels();

    const empty = d.t.length === 0 || extent(d.series.map((s) => s.values)) === null;
    this.emptyEl.style.display = empty ? '' : 'none';
    this.readout.style.visibility = empty ? 'hidden' : '';
    this.overlay.style.display = empty ? 'none' : '';
    if (empty) return;

    this.computeRange();
    this.writeReadoutWidths();
    const u = new uPlot(this.options(), this.aligned(), this.plotEl);
    this.u = u;
    // The canvas says nothing to a screen reader; the readout row and the labels do.
    u.root.setAttribute('aria-hidden', 'true');
    this.plotEl.insertBefore(u.root, this.overlay);
    this.buildCursor(u);
    this.lastIdx = -2;
    this.syncCursor(true);
  }

  private destroyPlot(): void {
    if (this.u) {
      this.u.over.removeEventListener('pointermove', this.onMove);
      this.u.over.removeEventListener('pointerdown', this.onDown);
      this.u.over.removeEventListener('pointerup', this.onUp);
      this.u.over.removeEventListener('pointercancel', this.onUp);
      this.u.destroy();
    }
    this.u = null;
    this.cursorEl = null;
    this.dotEls = [];
    this.focusEl = null;
  }

  private aligned(): uPlot.AlignedData {
    const d = this.data;
    const log = isLog(d);
    // A log axis cannot place x ≤ 0: those samples become gaps.
    const values = (i: number) => (log ? d.series[i].values.map((v, k) => (d.t[k] > 0 ? v : null)) : d.series[i].values) as (number | null)[];
    return [d.t as number[], ...this.order.map(values)];
  }

  /**
   * The page's span when this chart follows the page's cursor: every time chart on a page then
   * spans the same seconds (T−0 to burnout), so their cursors stand in one vertical line however
   * much of the burn each one has data for. A chart with a cursor of its own spans its data.
   */
  private sharedRange(): readonly [number, number] | null {
    if (this.store === this.ownStore || !isTimeAxis(this.data)) return null;
    return this.store.get().range;
  }

  private xRange(min: number, max: number): [number, number] {
    return spanRange(min, max, this.sharedRange());
  }

  private plotSize(): { width: number; height: number } {
    return { width: Math.max(40, Math.floor(this.plotEl.clientWidth)), height: Math.max(60, Math.floor(this.plotEl.clientHeight)) };
  }

  private computeRange(): void {
    const plotPx = this.plotSize().height - TOP_PAD - 22;
    const r = yScaleFor(this.data, plotPx);
    this.yr = r;
    this.digits = r.readoutDigits;
  }

  /** The text in the right gutter: each named series, then each named limit. */
  private gutterTexts(): string[] {
    const d = this.data;
    return [...d.series.filter((s) => s.label).map((s) => s.label), ...(d.limits ?? []).filter((l) => l.label).map((l) => l.label)];
  }

  /** The widest a gutter label may be at the current width [px]. */
  private labelCap(): number {
    return Math.max(36, Math.floor(this.plotSize().width * LABEL_MAX_SHARE));
  }

  private rightPad(): number {
    const cap = this.labelCap();
    const widths = this.gutterTexts().map((s) => Math.min(cap, textWidth(s, LABEL_FONT)));
    return widths.length ? Math.ceil(Math.max(...widths)) + LABEL_GAP + 4 : 12;
  }

  private xSplits(u: uPlot, min: number, max: number): number[] {
    const pxr = uPlot.pxRatio || 1;
    const px = u.bbox.width / pxr;
    const d = this.data;
    if (isLog(d)) return logTicks(min, max, px).ticks;
    if (isTimeAxis(d)) {
      const t = timeTicks(min, max, px);
      this.xDigits = t.digits;
      return t.ticks;
    }
    const t = linearTicks(min, max, tickCount(px, 72));
    this.xDigits = t.digits;
    return t.ticks;
  }

  private options(): uPlot.Options {
    const d = this.data;
    const c = (token: string) => () => this.colors.get(token);
    const pxr = uPlot.pxRatio || 1;
    const xLabel = d.xLabel ?? 's';
    const grid = { stroke: c('--lx-line'), width: 1 };
    const log = isLog(d);
    const series: uPlot.Series[] = [
      {},
      ...this.order.map((i): uPlot.Series => {
        const s = d.series[i];
        return {
          label: s.label || s.key,
          stroke: c(s.ghost ? TEXT_3 : s.color),
          width: s.ghost ? 1 : (s.width ?? 1.5),
          alpha: s.ghost ? 0.7 : 1,
          dash: s.dash?.map((v) => v * pxr),
          points: { show: false },
          spanGaps: false,
        };
      }),
    ];
    return {
      ...this.plotSize(),
      padding: [TOP_PAD, () => this.rightPad(), 0, 0],
      legend: { show: false },
      cursor: { show: false },
      focus: { alpha: 1 },
      scales: {
        x: log
          ? { time: false, distr: 3, log: 10 }
          : { time: false, range: (_u, min, max) => this.xRange(min, max) },
        y: { range: () => [this.yr.lo, this.yr.hi] },
      },
      axes: [
        {
          scale: 'x',
          stroke: c(TEXT_3),
          font: AXIS_FONT,
          size: 22,
          gap: 5,
          ticks: { show: false },
          grid,
          splits: (u, _i, min, max) => this.xSplits(u, min, max),
          // The splits are already thinned to what fits: uPlot's own log filter would blank some.
          filter: (_u, splits) => splits,
          values: (u, splits) => {
            if (log) {
              const lt = logTicks(u.scales.x.min ?? splits[0], u.scales.x.max ?? splits[splits.length - 1], u.bbox.width / pxr);
              return splits.map((v, k) => {
                if (v === null || v === undefined) return '';
                const at = lt.ticks.indexOf(v);
                const text = at >= 0 ? lt.labels[at] : xText(v, '');
                return k === splits.length - 1 && xLabel ? `${text}\u00a0${xLabel}` : text;
              });
            }
            return xTickLabels(splits, this.xDigits, xLabel);
          },
        },
        {
          scale: 'y',
          side: 3,
          stroke: c(TEXT_3),
          font: AXIS_FONT,
          gap: Y_GAP,
          // Wide enough for the widest tick and for the unit that heads the column.
          size: (_u, values) => {
            const ticks = values?.length ? Math.max(...values.map((v) => textWidth(String(v), AXIS_FONT))) : 20;
            const unit = d.yUnit ? textWidth(d.yUnit, UNIT_FONT) : 0;
            return Math.ceil(Math.max(ticks, unit)) + Y_GAP + 6;
          },
          ticks: { show: false },
          grid,
          splits: () => this.yr.ticks,
          values: (_u, splits) => splits.map((v) => num(v, this.yr.digits)),
        },
      ],
      series,
      hooks: {
        drawAxes: [(u) => this.drawUnder(u)],
        draw: [(u) => this.drawMarks(u)],
      },
    };
  }

  private buildReadout(): void {
    const d = this.data;
    this.readout.replaceChildren();
    // The y unit heads the tick column, on the readout's row: one place for it on every chart.
    this.unitEl.textContent = d.yUnit;
    this.readout.appendChild(this.unitEl);
    this.xValueEl = null;
    if (!isTimeAxis(d)) {
      const item = el('span', 'lx-chart-ro lx-chart-ro-x', this.readout);
      this.xValueEl = el('span', 'lx-chart-ro-value lx-num', item);
      this.xValueEl.textContent = '—';
    }
    this.valueEls = d.series.map((s) => {
      const item = el('span', `lx-chart-ro${s.ghost ? ' lx-chart-ro-ghost' : ''}`, this.readout);
      const key = el('i', 'lx-chart-ro-key', item);
      key.style.borderTopColor = s.ghost ? `var(${TEXT_3})` : cssColor(s.color);
      if (s.dash?.length) key.style.borderTopStyle = 'dashed';
      // A compared run named nowhere is still told apart: "vs".
      const name = s.label || (s.ghost ? 'vs' : '');
      if (name) el('span', 'lx-chart-ro-label', item).textContent = name;
      const value = el('span', 'lx-chart-ro-value lx-num', item);
      value.textContent = '—';
      return value;
    });
    // A screen reader hears the unit with the values; the eye reads it once, at the column head.
    if (d.yUnit) {
      const sr = el('span', 'lx-chart-sr', this.readout);
      sr.textContent = `(${d.yUnit})`;
    }
  }

  /** Fixed value widths, so a scrubbed readout does not shuffle its neighbours. */
  private writeReadoutWidths(): void {
    this.data.series.forEach((s, k) => {
      const ext = extent([s.values]);
      const chars = ext ? Math.max(num(ext[0], this.digits).length, num(ext[1], this.digits).length) : 1;
      const v = this.valueEls[k];
      if (v) v.style.minWidth = `${chars}ch`;
    });
  }

  private buildLabels(): void {
    for (const e of this.labelEls) e?.remove();
    for (const e of this.limitEls) e.remove();
    const d = this.data;
    this.labelEls = d.series.map((s) => {
      if (!s.label) return null;
      const e = el('span', `lx-chart-label${s.ghost ? ' lx-chart-label-ghost' : ''}`, this.overlay);
      e.textContent = s.label;
      e.style.color = s.ghost ? `var(${TEXT_3})` : cssColor(s.color);
      return e;
    });
    this.limitEls = (d.limits ?? []).map((l) => {
      const e = el('span', `lx-chart-label lx-chart-limit lx-chart-limit-${l.status}`, this.overlay);
      e.textContent = l.label;
      return e;
    });
  }

  private buildCursor(u: uPlot): void {
    const over = u.over;
    over.classList.add('lx-chart-over');
    this.cursorEl = el('div', 'lx-chart-cursor', over);
    this.dotEls = this.data.series.map((s) => {
      const e = el('span', `lx-chart-dot${s.ghost ? ' lx-chart-dot-ghost' : ''}`, over);
      e.style.backgroundColor = s.ghost ? `var(${TEXT_3})` : cssColor(s.color);
      return e;
    });
    over.addEventListener('pointermove', this.onMove);
    over.addEventListener('pointerdown', this.onDown);
    over.addEventListener('pointerup', this.onUp);
    over.addEventListener('pointercancel', this.onUp);
  }

  // ------------------------------------------------------------------ draw

  /** Under the grid's lines: shaded x spans, then the value bands. */
  private drawUnder(u: uPlot): void {
    const d = this.data;
    const { ctx } = u;
    const { left, top, width, height } = u.bbox;
    ctx.save();
    for (const s of d.spans ?? []) {
      const x1 = u.valToPos(Math.min(s.from, s.to), 'x', true);
      const x2 = u.valToPos(Math.max(s.from, s.to), 'x', true);
      const a = Math.max(left, x1);
      const b = Math.min(left + width, x2);
      if (!(b > a)) continue;
      ctx.globalAlpha = s.status ? 0.07 : 0.05;
      ctx.fillStyle = this.colors.get(s.status ? STATUS_TOKEN[s.status] : '--lx-text');
      ctx.fillRect(a, top, b - a, height);
    }
    const bands: ChartBand[] = [...(d.bands ?? []), ...(d.band ? [d.band] : [])];
    for (const band of bands) {
      const y1 = u.valToPos(Math.max(band.hi, band.lo), 'y', true);
      const y2 = u.valToPos(Math.min(band.hi, band.lo), 'y', true);
      const a = Math.max(top, Math.min(y1, y2));
      const b = Math.min(top + height, Math.max(y1, y2));
      if (b <= a) continue;
      ctx.globalAlpha = 0.06;
      ctx.fillStyle = this.colors.get(STATUS_TOKEN[band.status]);
      ctx.fillRect(left, a, width, b - a);
    }
    ctx.restore();
  }

  private drawMarks(u: uPlot): void {
    const { ctx } = u;
    const { left, top, width, height } = u.bbox;
    const pxr = uPlot.pxRatio || 1;
    const d = this.data;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, width, height);
    ctx.clip();

    // Limits: dashed, in their status colour, across the whole plot.
    for (const l of d.limits ?? []) {
      const y = Math.round(u.valToPos(l.value, 'y', true)) + 0.5;
      if (y < top - 1 || y > top + height + 1) continue;
      ctx.strokeStyle = this.colors.get(STATUS_TOKEN[l.status]);
      ctx.lineWidth = pxr;
      ctx.setLineDash([5 * pxr, 4 * pxr]);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(left + width, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Events: faint ticks standing on the time axis.
    if (d.events?.length && isTimeAxis(d)) {
      ctx.strokeStyle = this.colors.get(TEXT_3);
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = pxr;
      ctx.beginPath();
      for (const e of d.events) {
        const x = Math.round(u.valToPos(e.t, 'x', true)) + 0.5;
        if (x < left || x > left + width) continue;
        ctx.moveTo(x, top + height);
        ctx.lineTo(x, top + height - 6 * pxr);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // The worst point: a ring.
    const w = this.worstPoint(u);
    if (w) {
      ctx.strokeStyle = this.colors.get('--lx-text');
      ctx.lineWidth = 1.5 * pxr;
      ctx.beginPath();
      ctx.arc(w.x * pxr, w.y * pxr, RING * pxr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    this.layoutText(u, w);
    this.lastIdx = -2;
    this.syncCursor(true);
  }

  /** The worst point in CSS px from the canvas's top-left (not the plot area's), or null. */
  private worstPoint(u: uPlot): { x: number; y: number } | null {
    const w = this.data.worst;
    if (!w) return null;
    const s = this.data.series.find((x) => x.key === w.seriesKey);
    const v = s?.values[w.index];
    const t = this.data.t[w.index];
    if (v === null || v === undefined || t === undefined || !Number.isFinite(v)) return null;
    const pxr = uPlot.pxRatio || 1;
    return { x: u.valToPos(t, 'x', true) / pxr, y: u.valToPos(v, 'y', true) / pxr };
  }

  /** Every drawn line in CSS px (canvas frame), thinned to about one point per pixel column. */
  private polylines(u: uPlot): number[][] {
    const d = this.data;
    const out: number[][] = [];
    for (const s of d.series) {
      let line: number[] = [];
      let lastX = -Infinity;
      for (let i = 0; i < d.t.length; i++) {
        const v = s.values[i];
        if (v === null || v === undefined || !Number.isFinite(v) || (isLog(d) && !(d.t[i] > 0))) {
          if (line.length >= 4) out.push(line);
          line = [];
          lastX = -Infinity;
          continue;
        }
        const x = u.valToPos(d.t[i], 'x');
        if (x - lastX < 1 && i < d.t.length - 1) continue;
        lastX = x;
        line.push(x + u.bbox.left / (uPlot.pxRatio || 1), u.valToPos(v, 'y') + u.bbox.top / (uPlot.pxRatio || 1));
      }
      if (line.length >= 4) out.push(line);
    }
    return out;
  }

  /** The DOM text: the unit's place, the gutter labels, the worst-point note. */
  private layoutText(u: uPlot, worst: { x: number; y: number } | null): void {
    const pxr = uPlot.pxRatio || 1;
    const left = u.bbox.left / pxr;
    const top = u.bbox.top / pxr;
    const width = u.bbox.width / pxr;
    const height = u.bbox.height / pxr;
    const d = this.data;

    // The readout starts at the plot's left edge; the unit sits in the gutter before it, right-
    // aligned with the tick labels under it.
    this.readout.style.paddingLeft = `${Math.round(left)}px`;
    this.unitEl.style.width = `${Math.max(0, Math.round(left - Y_GAP))}px`;

    // The right gutter: series at their last values, limits at theirs, nudged apart together.
    const cap = this.labelCap();
    const items: { key: string; y: number; h: number }[] = [];
    d.series.forEach((s, k) => {
      if (!s.label) return;
      const v = lastFinite(s.values);
      items.push({ key: `s${k}`, y: v === null ? Number.NaN : top + u.valToPos(v, 'y'), h: LABEL_H });
    });
    (d.limits ?? []).forEach((l, k) => {
      if (!l.label) return;
      const y = top + u.valToPos(l.value, 'y');
      items.push({ key: `l${k}`, y: y < top - 1 || y > top + height + 1 ? Number.NaN : y, h: LABEL_H });
    });
    const placed = placeLabels(items, top, top + height, 2);
    const put = (e: HTMLSpanElement | null, key: string) => {
      if (!e) return;
      // A limit with no label (or one off the plot) has no key in `placed`: hidden.
      const y = placed.get(key);
      if (y === undefined) {
        e.style.display = 'none';
        return;
      }
      e.style.display = '';
      e.style.maxWidth = `${cap}px`;
      e.style.transform = `translate(${left + width + LABEL_GAP}px, ${y - LABEL_H / 2}px)`;
    };
    this.labelEls.forEach((e, k) => put(e, `s${k}`));
    this.limitEls.forEach((e, k) => put(e, `l${k}`));

    // The worst point's note: beside its ring, wherever it crosses no limit line and the fewest
    // data lines, inside the plot.
    if (worst && d.worst?.text) {
      this.annoEl.style.display = '';
      this.annoEl.textContent = d.worst.text;
      const size = { w: this.annoEl.offsetWidth || textWidth(d.worst.text, AXIS_FONT) + 6, h: this.annoEl.offsetHeight || 14 };
      const limitsY = (d.limits ?? []).map((l) => top + u.valToPos(l.value, 'y'));
      // The event ticks along the bottom are text-like: keep the note off them.
      const eventsStrip: Box[] = d.events?.length && isTimeAxis(d) ? [{ x: left, y: top + height - 7, w: width, h: 7 }] : [];
      const box = placeNote(worst, size, { x: left + 1, y: top + 1, w: width - 2, h: height - 2 },
        { polylines: this.polylines(u), hlines: limitsY, boxes: eventsStrip }, RING);
      this.annoEl.style.transform = `translate(${Math.round(box.x)}px, ${Math.round(box.y)}px)`;
      drawLeader(this.leaderEl, this.leaderLine, leaderFor(worst, box, RING));
    } else {
      this.annoEl.style.display = 'none';
      drawLeader(this.leaderEl, this.leaderLine, null);
    }
  }

  // ------------------------------------------------------------------ cursor

  private syncCursor(force: boolean): void {
    const u = this.u;
    const cursor = this.cursorEl;
    if (!u || !cursor) return;
    const ts = this.data.t;
    const n = ts.length;
    if (n === 0) return;
    const t = this.store.get().t;
    const spacing = n > 1 ? (ts[n - 1] - ts[0]) / (n - 1) : 0;
    // A cursor off this chart's span (a firing-only chart at T−0.5 s) is not shown on it.
    const idx = t < ts[0] - spacing || t > ts[n - 1] + spacing ? -1 : nearestIndex(ts, t);
    // Off this chart's samples but inside the page's span (a firing-only chart at T−0.4 s): the
    // line stands where every other chart's does, with no values.
    const shared = idx < 0 ? this.sharedRange() : null;
    const bareX = shared && t >= shared[0] && t <= shared[1] ? u.valToPos(t, 'x') : NaN;
    if (!force && idx === this.lastIdx && (idx >= 0 || Object.is(bareX, this.lastBareX) || Math.abs(bareX - this.lastBareX) < 0.5)) return;
    this.lastIdx = idx;
    this.lastBareX = bareX;
    const series = this.data.series;
    if (idx < 0 || (isLog(this.data) && !(ts[idx] > 0))) {
      cursor.style.display = Number.isFinite(bareX) ? '' : 'none';
      if (Number.isFinite(bareX)) cursor.style.transform = `translateX(${bareX}px)`;
      for (const dot of this.dotEls) if (dot) dot.style.display = 'none';
      for (const v of this.valueEls) v.textContent = '—';
      if (this.xValueEl) this.xValueEl.textContent = '—';
      return;
    }
    const x = u.valToPos(ts[idx], 'x');
    cursor.style.display = '';
    cursor.style.transform = `translateX(${x}px)`;
    if (this.xValueEl) this.xValueEl.textContent = xText(ts[idx], this.data.xLabel ?? '');
    for (let k = 0; k < series.length; k++) {
      const v = series[k].values[idx];
      const ok = v !== null && v !== undefined && Number.isFinite(v);
      const dot = this.dotEls[k];
      if (dot) {
        if (ok) {
          dot.style.display = '';
          dot.style.transform = `translate(${x}px, ${u.valToPos(v, 'y')}px)`;
        } else {
          dot.style.display = 'none';
        }
      }
      const out = this.valueEls[k];
      if (out) out.textContent = ok ? num(v, this.digits) : '—';
    }
  }

  private syncFocus(): void {
    const f = this.store.get().focus;
    const u = this.u;
    if (!f || f.seq === this.lastFocusSeq || !u) return;
    this.lastFocusSeq = f.seq;
    const ts = this.data.t;
    if (!ts.length || f.t < ts[0] || f.t > ts[ts.length - 1]) return;
    this.focusEl?.remove();
    if (this.focusTimer !== null) clearTimeout(this.focusTimer);
    const x = u.valToPos(f.t, 'x');
    const s = this.data.series.find((x) => x.key === f.key);
    const v = s ? s.values[nearestIndex(ts, f.t)] : null;
    const e = el('span', v !== null && v !== undefined ? 'lx-chart-focus lx-chart-focus-ring' : 'lx-chart-focus lx-chart-focus-line', u.over);
    // `translate`, not `transform`: the ring's pulse animates `scale`, which would scale a position
    // held in `transform` with it.
    e.style.translate = v !== null && v !== undefined ? `${x}px ${u.valToPos(v, 'y')}px` : `${x}px 0px`;
    this.focusEl = e;
    this.focusTimer = window.setTimeout(() => {
      e.remove();
      if (this.focusEl === e) this.focusEl = null;
      this.focusTimer = null;
    }, FOCUS_MS);
  }

  // ------------------------------------------------------------------ input

  /** Hovering any chart scrubs everything; a touch scrubs only while pressed. Playback wins. */
  private onMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' && !this.pressed) return;
    this.scrubTo(e);
  };

  private onDown = (e: PointerEvent): void => {
    this.pressed = true;
    if (e.pointerType === 'touch') this.u?.over.setPointerCapture?.(e.pointerId);
    if (this.store.get().playing) this.store.setPlaying(false);
    this.scrubTo(e);
  };

  private onUp = (): void => {
    this.pressed = false;
  };

  private scrubTo(e: PointerEvent): void {
    const u = this.u;
    if (!u || this.store.get().playing) return;
    const rect = u.over.getBoundingClientRect();
    const t = u.posToVal(e.clientX - rect.left, 'x');
    if (Number.isFinite(t)) {
      this.store.setT(t);
      // A cursor of its own has no page to drive it: show the move now.
      if (this.store === this.ownStore) this.store.flush();
    }
  }

  // ------------------------------------------------------------------ environment

  private queueResize(): void {
    if (this.resizeFrame !== null) return;
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = null;
      const u = this.u;
      if (!u || !this.alive) return;
      const size = this.plotSize();
      if (size.width === Math.round(u.width) && size.height === Math.round(u.height)) return;
      this.computeRange();
      u.setSize(size);
      u.setScale('y', { min: this.yr.lo, max: this.yr.hi });
    });
  }

  private retheme(): void {
    this.colors.reset();
    this.u?.redraw(false);
  }
}
