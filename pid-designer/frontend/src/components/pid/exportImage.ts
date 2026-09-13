/**
 * The drawing as a picture: a PNG or an SVG of the page being looked at,
 * with a title block along the bottom.
 *
 * A P&ID that lives only inside the tool it was drawn in is one that cannot
 * be printed for a review, pasted into a test plan or pinned to the wall of
 * the bay. Export used to mean the JSON, which is the drawing for a machine
 * and nothing for a person.
 *
 * Rendered from the live canvas rather than re-drawn: the symbols are React
 * components with SVG inside HTML, and `html-to-image` serialises exactly
 * what is on screen, so the export and the screen cannot disagree. The
 * viewport is repositioned for the shot -- framed on the page's symbols at a
 * scale that gives a crisp print -- and the canvas itself is never touched.
 */

import { toSvg } from 'html-to-image';
import { getNodesBounds, type Node } from '@xyflow/react';

/** What the title block says. */
export interface SheetMeta {
  name: string;
  page: string;
  /** The latest release label, or null for a working copy. */
  release?: string | null;
  date?: Date;
}

const PAD = 48;
const BLOCK_H = 56;
/** Pixels per flow unit. Two gives a print that survives being zoomed. */
const SCALE = 2;

const BG = () =>
  getComputedStyle(document.documentElement).getPropertyValue('--color-bg-primary').trim() || '#0a0f1a';

/**
 * How long a render may take before it is called off, so the menu cannot say
 * "Rendering…" for as long as anyone cares to wait.
 */
const RENDER_TIMEOUT_MS = 20_000;

function within<T>(p: Promise<T>, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(
      `${what} did not finish. The tab has to be visible to render a PNG; try the SVG instead.`)),
      RENDER_TIMEOUT_MS);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

/** `survey-claude · Main.png`, but a file name. */
export function fileStem(meta: SheetMeta): string {
  const clean = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '-').trim();
  return `${clean(meta.name)} - ${clean(meta.page)}`;
}

/**
 * The frame the shot is taken in: the visible symbols, padded.
 *
 * The transform is written out rather than asked of `getViewportForBounds`,
 * whose padding argument is a fraction of the frame. Handed a pixel count
 * it obliged with ninety-six times the frame, and the drawing was
 * translated clean off the sheet -- leaving a title block, one vent arrow
 * that happened to sit near the origin, and a pixel count that passed.
 */
function frame(flow: HTMLElement, nodes: Node[]) {
  const shown = nodes.filter(n => !n.hidden);
  const bounds = drawnBounds(flow) ?? getNodesBounds(shown.length ? shown : nodes);
  const width = Math.ceil((bounds.width + 2 * PAD) * SCALE);
  const height = Math.ceil((bounds.height + 2 * PAD) * SCALE);
  const x = (PAD - bounds.x) * SCALE;
  const y = (PAD - bounds.y) * SCALE;
  const viewport = flow.querySelector<HTMLElement>('.react-flow__viewport');
  if (!viewport) throw new Error('no canvas to export');
  return {
    viewport, width, height,
    style: {
      width: `${width}px`,
      height: `${height}px`,
      transform: `translate(${x}px, ${y}px) scale(${SCALE})`,
    },
  };
}

/**
 * The extent of what is actually drawn, in flow units.
 *
 * `getNodesBounds` is the symbols' boxes. A tag hangs below its symbol, a
 * setpoint under that, a turned valve's tag off to its side -- all outside
 * the box, and a frame drawn to the boxes cut MAN-FILL to "MAN-" at the
 * edge of the sheet. So the rendered elements are measured instead: every
 * node and everything inside it, mapped back through the viewport transform.
 */
function drawnBounds(flow: HTMLElement): { x: number; y: number; width: number; height: number } | null {
  const viewport = flow.querySelector<HTMLElement>('.react-flow__viewport');
  const pane = flow.getBoundingClientRect();
  const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([\d.]+)\)/.exec(viewport?.style.transform ?? '');
  if (!viewport || !m) return null;
  const tx = Number(m[1]), ty = Number(m[2]), k = Number(m[3]);
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const node of flow.querySelectorAll<HTMLElement>('.react-flow__node')) {
    if (node.hidden || node.style.visibility === 'hidden') continue;
    for (const el of [node, ...node.querySelectorAll<HTMLElement>('*')]) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      left = Math.min(left, r.left); top = Math.min(top, r.top);
      right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom);
    }
  }
  if (!Number.isFinite(left)) return null;
  const toFlow = (sx: number, sy: number) => ({ x: (sx - pane.left - tx) / k, y: (sy - pane.top - ty) / k });
  const a = toFlow(left, top), b = toFlow(right, bottom);
  return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
}

/** What html-to-image should leave out: chrome, not drawing. */
const notChrome = (el: HTMLElement) =>
  !(el.classList?.contains('react-flow__minimap') || el.classList?.contains('react-flow__controls')
    || el.classList?.contains('react-flow__panel'));

/**
 * The PNG is rasterised here, from the SVG, rather than by the library's own
 * `toPng`. That one hands the SVG to `HTMLImageElement.decode()`, which a
 * background tab defers indefinitely for a document this size -- the same
 * SVG fires `onload` in a millisecond. Drawing it onto a canvas of our own
 * is also where the title block goes, so nothing is lost by owning the step.
 */
export async function exportPng(flow: HTMLElement, nodes: Node[], meta: SheetMeta): Promise<Blob> {
  const f = frame(flow, nodes);
  const url = await within(toSvg(f.viewport, {
    backgroundColor: BG(), width: f.width, height: f.height, style: f.style, filter: notChrome,
  }), 'rendering the drawing');
  const img = await within(load(url), 'decoding the drawing');
  const canvas = document.createElement('canvas');
  canvas.width = f.width;
  canvas.height = f.height + BLOCK_H * SCALE;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = BG();
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  drawTitleBlock(ctx, canvas.width, f.height, meta);
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('could not encode PNG'))), 'image/png'));
}

export async function exportSvg(flow: HTMLElement, nodes: Node[], meta: SheetMeta): Promise<Blob> {
  const f = frame(flow, nodes);
  const url = await toSvg(f.viewport, {
    backgroundColor: BG(), width: f.width, height: f.height, style: f.style, filter: notChrome,
  });
  // `toSvg` hands back a data URL of an <svg> wrapping a foreignObject. The
  // title block is appended as plain SVG below it, and the sheet grown to fit.
  const svgText = decodeURIComponent(url.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = doc.documentElement;
  const total = f.height + BLOCK_H * SCALE;
  svg.setAttribute('height', String(total));
  svg.setAttribute('viewBox', `0 0 ${f.width} ${total}`);
  svg.appendChild(titleBlockSvg(doc, f.width, f.height, meta));
  const out = new XMLSerializer().serializeToString(svg);
  return new Blob([out], { type: 'image/svg+xml;charset=utf-8' });
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── The title block ──────────────────────────────────────────────────────────

/** The block's rows: label, value. What a drawing says about itself. */
export function titleRows(meta: SheetMeta): [string, string][] {
  const date = (meta.date ?? new Date()).toISOString().slice(0, 10);
  return [
    ['DRAWING', meta.name],
    ['SHEET', meta.page],
    ['REV', meta.release ?? 'working copy'],
    ['DATE', date],
  ];
}

const INK = '#cbd5e1';
const MUTED = '#64748b';
const RULE = '#334155';

function drawTitleBlock(ctx: CanvasRenderingContext2D, width: number, top: number, meta: SheetMeta) {
  const h = BLOCK_H * SCALE;
  ctx.strokeStyle = RULE;
  ctx.lineWidth = SCALE;
  ctx.beginPath();
  ctx.moveTo(0, top + 0.5);
  ctx.lineTo(width, top + 0.5);
  ctx.stroke();
  const rows = titleRows(meta);
  const cell = width / rows.length;
  rows.forEach(([label, value], i) => {
    const x = i * cell + 16 * SCALE;
    if (i > 0) {
      ctx.beginPath();
      ctx.moveTo(i * cell + 0.5, top);
      ctx.lineTo(i * cell + 0.5, top + h);
      ctx.stroke();
    }
    ctx.fillStyle = MUTED;
    ctx.font = `${9 * SCALE}px ui-monospace, Menlo, monospace`;
    ctx.fillText(label, x, top + 18 * SCALE);
    ctx.fillStyle = INK;
    ctx.font = `${i === 0 ? 'bold ' : ''}${13 * SCALE}px ui-monospace, Menlo, monospace`;
    ctx.fillText(value, x, top + 40 * SCALE);
  });
}

function titleBlockSvg(doc: Document, width: number, top: number, meta: SheetMeta): Element {
  const NS = 'http://www.w3.org/2000/svg';
  const g = doc.createElementNS(NS, 'g');
  const h = BLOCK_H * SCALE;
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    const l = doc.createElementNS(NS, 'line');
    l.setAttribute('x1', String(x1)); l.setAttribute('y1', String(y1));
    l.setAttribute('x2', String(x2)); l.setAttribute('y2', String(y2));
    l.setAttribute('stroke', RULE); l.setAttribute('stroke-width', String(SCALE));
    g.appendChild(l);
  };
  const text = (x: number, y: number, s: string, size: number, fill: string, bold = false) => {
    const t = doc.createElementNS(NS, 'text');
    t.setAttribute('x', String(x)); t.setAttribute('y', String(y));
    t.setAttribute('font-family', 'ui-monospace, Menlo, monospace');
    t.setAttribute('font-size', String(size * SCALE));
    if (bold) t.setAttribute('font-weight', 'bold');
    t.setAttribute('fill', fill);
    t.textContent = s;
    g.appendChild(t);
  };
  line(0, top, width, top);
  const rows = titleRows(meta);
  const cell = width / rows.length;
  rows.forEach(([label, value], i) => {
    const x = i * cell + 16 * SCALE;
    if (i > 0) line(i * cell, top, i * cell, top + h);
    text(x, top + 18 * SCALE, label, 9, MUTED);
    text(x, top + 40 * SCALE, value, 13, INK, i === 0);
  });
  return g;
}

function load(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not render the drawing'));
    img.src = url;
  });
}
