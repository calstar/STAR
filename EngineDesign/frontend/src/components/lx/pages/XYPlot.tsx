import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { stepDigits } from '../../layerx/format';
import { extent, niceRange } from '../charts/scale';
import { NBSP } from '../units';

/**
 * A small x–y plot in SVG, for the few views whose x is not time: the operating map (O/F, Pc) and
 * the Nyquist locus. Lines are named at their ends, points carry their own label, and a cursor
 * point follows the page's time cursor (given by the caller).
 *
 * TODO(charts): an XY chart capability in lx/charts (x–y lines, a moving point, direct labels,
 * themed and resized like Chart). This page-local plot stands in until it exists.
 */

export interface XYLine {
  key: string;
  label: string;
  /** A token (`--lx-hot`) or a CSS colour. */
  color: string;
  x: readonly (number | null)[];
  y: readonly (number | null)[];
  dash?: string;
  width?: number;
  ghost?: boolean;
  /** A closed, faintly filled region rather than a line. */
  fill?: boolean;
  /** false: drawn (clipped) inside the frame the other lines set, never widening it. */
  scale?: boolean;
}

export interface XYPoint {
  key: string;
  x: number;
  y: number;
  label?: string;
  color: string;
  shape?: 'ring' | 'dot' | 'cross';
}

const col = (c: string) => (c.startsWith('--') ? `var(${c})` : c);

function fmtTick(v: number, digits: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace(/^-/, '−');
}

export function XYPlot({ lines, points = [], cursor, xUnit, yUnit, height = 240, square = false, title, footer }: {
  lines: XYLine[];
  points?: XYPoint[];
  /** The point at the time cursor, drawn as a dot on top. */
  cursor?: { x: number | null; y: number | null; color: string } | null;
  xUnit: string;
  yUnit: string;
  height?: number;
  /** One unit of x is one unit of y on screen (a Nyquist plot). */
  square?: boolean;
  title: string;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(400);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // The observer reports the first size as soon as it observes.
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 400));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    const extraX = points.map((p) => p.x);
    const extraY = points.map((p) => p.y);
    const framing = lines.filter((l) => l.scale !== false);
    const widen = (e: [number, number] | null, f: number): [number, number] => {
      if (!e) return [0, 1];
      const span = e[1] - e[0] || Math.abs(e[0]) * 0.1 || 1;
      return [e[0] - f * span, e[1] + f * span];
    };
    const ex = widen(extent(framing.map((l) => l.x), extraX), framing.length < lines.length ? 0.15 : 0);
    const ey = widen(extent(framing.map((l) => l.y), extraY), framing.length < lines.length ? 0.15 : 0);
    const pad = { l: 44, r: 92, t: 24, b: 26 };
    const w = Math.max(60, width - pad.l - pad.r);
    const h = Math.max(40, height - pad.t - pad.b);
    let xr = niceRange(ex[0], ex[1], Math.max(2, Math.round(w / 90)));
    let yr = niceRange(ey[0], ey[1], Math.max(2, Math.round(h / 50)));
    if (square) {
      // Widen the narrower span so one unit is the same length both ways.
      const kx = (xr.hi - xr.lo) / w;
      const ky = (yr.hi - yr.lo) / h;
      if (kx > ky) {
        const mid = (yr.hi + yr.lo) / 2;
        yr = niceRange(mid - (kx * h) / 2, mid + (kx * h) / 2, Math.max(2, Math.round(h / 50)));
      } else {
        const mid = (xr.hi + xr.lo) / 2;
        xr = niceRange(mid - (ky * w) / 2, mid + (ky * w) / 2, Math.max(2, Math.round(w / 90)));
      }
    }
    const X = (v: number) => pad.l + ((v - xr.lo) / (xr.hi - xr.lo || 1)) * w;
    const Y = (v: number) => pad.t + (1 - (v - yr.lo) / (yr.hi - yr.lo || 1)) * h;
    return { pad, w, h, xr, yr, X, Y };
  }, [lines, points, width, height, square]);

  const { pad, w, h, xr, yr, X, Y } = geo;
  const pathOf = (l: XYLine) => {
    let d = '';
    let pen = false;
    const n = Math.min(l.x.length, l.y.length);
    for (let k = 0; k < n; k++) {
      const a = l.x[k];
      const b = l.y[k];
      if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${X(a).toFixed(1)} ${Y(b).toFixed(1)}`;
      pen = true;
    }
    return l.fill ? `${d}Z` : d;
  };
  const inside = (a: number, b: number) => a >= xr.lo && a <= xr.hi && b >= yr.lo && b <= yr.hi;
  const endOf = (l: XYLine): [number, number] | null => {
    for (let k = Math.min(l.x.length, l.y.length) - 1; k >= 0; k--) {
      const a = l.x[k];
      const b = l.y[k];
      if (a !== null && b !== null && Number.isFinite(a) && Number.isFinite(b) && inside(a, b)) return [X(a), Y(b)];
    }
    return null;
  };
  const clipId = `xy-${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  // Direct labels at the line ends, nudged apart vertically.
  const labels = lines.filter((l) => l.label && !l.ghost).map((l) => ({ l, at: endOf(l) })).filter((x): x is { l: XYLine; at: [number, number] } => !!x.at)
    .sort((a, b) => a.at[1] - b.at[1]);
  for (let k = 1; k < labels.length; k++) if (labels[k].at[1] - labels[k - 1].at[1] < 13) labels[k].at = [labels[k].at[0], labels[k - 1].at[1] + 13];

  const xd = stepDigits(xr.step);
  const yd = stepDigits(yr.step);
  return (
    <figure ref={ref} className="m-0 min-w-0" aria-label={title}>
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title} className="block overflow-visible">
        <g fontSize={11} fill="var(--lx-text-3)" className="lx-num">
          {yr.ticks.map((v) => (
            <g key={`y${v}`}>
              <line x1={pad.l} x2={pad.l + w} y1={Y(v)} y2={Y(v)} stroke="var(--lx-line)" strokeWidth={1} />
              <text x={pad.l - 6} y={Y(v) + 4} textAnchor="end">{fmtTick(v, yd)}</text>
            </g>
          ))}
          {xr.ticks.map((v, k) => (
            <g key={`x${v}`}>
              <line x1={X(v)} x2={X(v)} y1={pad.t} y2={pad.t + h} stroke="var(--lx-line)" strokeWidth={1} />
              <text x={X(v)} y={pad.t + h + 16} textAnchor="middle">{fmtTick(v, xd)}{k === xr.ticks.length - 1 && xUnit ? `${NBSP}${xUnit}` : ''}</text>
            </g>
          ))}
          {yUnit && <text x={pad.l - 6} y={11} textAnchor="end">{yUnit}</text>}
        </g>
        <defs><clipPath id={clipId}><rect x={pad.l} y={pad.t} width={w} height={h} /></clipPath></defs>
        <g fill="none" strokeLinejoin="round" strokeLinecap="round" clipPath={`url(#${clipId})`}>
          {lines.filter((l) => l.fill).map((l) => (
            <path key={l.key} d={pathOf(l)} fill={col(l.color)} fillOpacity={0.08} stroke={col(l.color)} strokeOpacity={0.5} strokeWidth={1} strokeDasharray={l.dash} />
          ))}
          {lines.filter((l) => l.ghost && !l.fill).map((l) => (
            <path key={l.key} d={pathOf(l)} stroke="var(--lx-ghost, var(--lx-text-3))" strokeOpacity={0.7} strokeWidth={1} />
          ))}
          {lines.filter((l) => !l.ghost && !l.fill).map((l) => (
            <path key={l.key} d={pathOf(l)} stroke={col(l.color)} strokeWidth={l.width ?? 1.5} strokeDasharray={l.dash} />
          ))}
        </g>
        {points.map((p) => (
          <g key={p.key}>
            {p.shape === 'cross'
              ? <path d={`M${X(p.x) - 4} ${Y(p.y) - 4}L${X(p.x) + 4} ${Y(p.y) + 4}M${X(p.x) - 4} ${Y(p.y) + 4}L${X(p.x) + 4} ${Y(p.y) - 4}`} stroke={col(p.color)} strokeWidth={1.5} />
              : <circle cx={X(p.x)} cy={Y(p.y)} r={p.shape === 'dot' ? 3 : 5} fill={p.shape === 'dot' ? col(p.color) : 'var(--lx-surface)'} stroke={col(p.color)} strokeWidth={1.5} />}
            {p.label && <text x={X(p.x) + 8} y={Y(p.y) - 7} fontSize={11} fill={col(p.color)} fontWeight={500}>{p.label}</text>}
          </g>
        ))}
        {labels.map(({ l, at }) => (
          <text key={l.key} x={Math.min(at[0] + 8, pad.l + w + 8)} y={at[1] + 4} fontSize={11} fontWeight={500} fill={col(l.color)}>{l.label}</text>
        ))}
        {cursor && cursor.x !== null && cursor.y !== null && Number.isFinite(cursor.x) && Number.isFinite(cursor.y) && (
          <circle cx={X(cursor.x)} cy={Y(cursor.y)} r={4} fill={col(cursor.color)} stroke="var(--lx-surface)" strokeWidth={1.5} />
        )}
      </svg>
      {footer && <figcaption className="mt-1 text-[11px] text-[var(--lx-text-3)]">{footer}</figcaption>}
    </figure>
  );
}
