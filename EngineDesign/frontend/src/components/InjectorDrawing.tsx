import { useId, useMemo } from 'react';
import type { Primitive } from '../lib/drawingPrimitives';
import { bbox } from '../lib/drawingPrimitives';
import { OX, FU } from '../lib/injectorDrawing';

/**
 * Renders a list of drawing primitives (engine/core/injectors/drawing.py) true to scale.
 *
 * One scale for both axes, always: the old section stretched the axial direction 3-4x to make
 * the standoff visible, which also flattened every passage angle -- the one thing a section
 * through an inclined-hole injector is for. Line weights do not scale with zoom
 * (non-scaling-stroke), so a 1 mm web and a 127 mm bore read at the same pen.
 */

const WALL = 'var(--color-text-secondary)';
const INK = 'var(--color-text-primary)';
const BG = 'var(--color-bg-secondary)';
const WARN = '#fbbf24';
const BAD = '#f87171';

interface Style {
  stroke?: string;
  width?: number;
  dash?: string;
  fill?: string;
  opacity?: number;
}

const STYLE: Record<string, Style> = {
  PLATE: { stroke: WALL, width: 1.2 },
  SLEEVE: { stroke: WALL, width: 1.0, fill: '#6b7280', opacity: 0.35 },
  LINER: { stroke: '#a0522d', width: 0.9, fill: '#8b4513', opacity: 0.45 },
  GROOVE: { stroke: INK, width: 0.8 },
  CHANNEL_O: { stroke: OX, width: 1.0 },
  CHANNEL_F: { stroke: FU, width: 1.0 },
  CHAMBER: { stroke: WALL, width: 1.4 },
  PASSAGE_O: { stroke: OX, width: 1.1, fill: BG },
  PASSAGE_F: { stroke: FU, width: 1.1, fill: BG },
  // A hole's open space in section: filled, never outlined (its walls are PASSAGE lines).
  HOLE_O: { stroke: 'none', fill: BG },
  HOLE_F: { stroke: 'none', fill: BG },
  JET_O: { stroke: OX, width: 1.3, dash: '4 2' },
  JET_F: { stroke: FU, width: 1.3, dash: '4 2' },
  IMPINGE: { stroke: INK, width: 1, fill: INK },
  IMPINGE_RING: { stroke: INK, width: 0.9, dash: '5 3', opacity: 0.55 },
  IGNITER: { stroke: INK, width: 1 },
  BAD: { stroke: BAD, width: 1.4 },
  THREAD: { stroke: WALL, width: 0.8 },
  HIDDEN: { stroke: WALL, width: 0.7, dash: '3 2', opacity: 0.6 },
  CENTER: { stroke: WALL, width: 0.5, dash: '10 3 2 3', opacity: 0.5 },
  BREAK: { stroke: WALL, width: 0.7, opacity: 0.8 },
  PITCH_O: { stroke: OX, width: 0.6, dash: '3 3', opacity: 0.5 },
  PITCH_F: { stroke: FU, width: 0.6, dash: '3 3', opacity: 0.5 },
  KEEPOUT: { stroke: WALL, width: 1, dash: '5 2' },
  LAND: { stroke: WARN, width: 0.7, dash: '2 2', opacity: 0.8 },
  NOTE: { stroke: WALL },
  DIM: { stroke: WALL, width: 0.6 },
};

// Plate and liner first, then everything cut out of them, then lines, then annotation.
const ORDER = ['SLEEVE', 'LINER', 'PLATE', 'HOLE_O', 'HOLE_F', 'PASSAGE_O', 'PASSAGE_F'];
const rank = (p: Primitive) => {
  if (p.t === 'dim' || p.t === 'text') return 100;
  const i = ORDER.indexOf(p.layer);
  return i >= 0 ? i : 50;
};

/** Approximate extent of every label [m], so none is cut off at the view's edge. */
function withText(prims: Primitive[], g: ReturnType<typeof bbox>, fs: number) {
  let { x0, y0, x1, y1 } = g;
  const w = (s: string) => s.length * 0.6 * fs;
  const add = (xa: number, xb: number, y: number) => {
    x0 = Math.min(x0, xa); x1 = Math.max(x1, xb); y0 = Math.min(y0, y - 0.4 * fs); y1 = Math.max(y1, y + fs);
  };
  for (const p of prims) {
    if (p.t === 'text') {
      const [x, y] = p.at;
      if (p.anchor === 'start') add(x, x + w(p.text), y);
      else if (p.anchor === 'end') add(x - w(p.text), x, y);
      else add(x - w(p.text) / 2, x + w(p.text) / 2, y);
    } else if (p.t === 'dim') {
      const ax = p.a[0] + p.off[0], bx = p.b[0] + p.off[0];
      const my = 0.5 * (p.a[1] + p.b[1]) + p.off[1];
      if (Math.abs(ax - bx) < Math.abs(p.a[1] - p.b[1])) {
        if (p.side === 'right') add(ax, ax + 0.4 * fs + w(p.text), my);
        else add(ax - 0.4 * fs - w(p.text), ax, my);
      } else {
        const right = Math.max(ax, bx);
        add(Math.min(ax, bx), Math.max(right, right + 0.6 * fs + w(p.text)), my);
      }
    }
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

interface Props {
  prims: Primitive[];
  /** Hatch the PLATE layer, as a cut section is drawn. */
  sectioned?: boolean;
  /** Draw these layers in the fail colour (e.g. KEEPOUT when the centre clearance fails). */
  badLayers?: string[];
  hover?: string | null;
  onHover?: (id: string | null) => void;
  maxHeight?: number;
  /** Text size relative to the default (a mirrored section is twice as wide for the same labels). */
  textScale?: number;
}

export function InjectorDrawing({
  prims, sectioned = false, badLayers = [], hover = null, onHover, maxHeight = 360, textScale = 1,
}: Props) {
  const hatchId = useId().replace(/:/g, '');
  // The text size follows the geometry; the view box then grows to hold the text too.
  const geo = useMemo(() => bbox(prims), [prims]);
  const box = useMemo(() => withText(prims, geo, (textScale * Math.max(geo.w, geo.h)) / 48), [prims, geo, textScale]);
  // Model metres -> SVG units in mm, y flipped (SVG y runs down).
  const S = 1000;
  const pad = 0.03 * Math.max(box.w, box.h);
  const vb = [(box.x0 - pad) * S, -(box.y1 + pad) * S, (box.w + 2 * pad) * S, (box.h + 2 * pad) * S];
  const fontSize = (textScale * Math.max(geo.w, geo.h) * S) / 48;
  const X = (x: number) => x * S;
  const Y = (y: number) => -y * S;

  const styleFor = (layer: string, id?: string): Style & { hot: boolean } => {
    const base = STYLE[layer] ?? { stroke: WALL };
    const bad = badLayers.includes(layer);
    const hot = !!id && id === hover;
    return {
      ...base,
      stroke: bad ? BAD : base.stroke,
      width: (base.width ?? 1) * (hot ? 2.2 : 1),
      fill: hot && base.fill ? INK : base.fill,
      opacity: hot ? 1 : base.opacity,
      hot,
    };
  };

  const common = (layer: string, id?: string, isCircle = false) => {
    const st0 = styleFor(layer, id);
    // Filled layers are cut sections; drawn as circles in a face view they are outlines only.
    const st = isCircle && (layer === 'SLEEVE' || layer === 'LINER') ? { ...st0, fill: undefined } : st0;
    return {
      stroke: st.stroke,
      strokeWidth: st.width,
      strokeDasharray: st.dash,
      fill: layer === 'PLATE' && sectioned ? `url(#${hatchId})` : (st.fill ?? 'none'),
      fillOpacity: st.fill ? st.opacity ?? 1 : undefined,
      strokeOpacity: st.fill ? undefined : st.opacity,
      vectorEffect: 'non-scaling-stroke' as const,
      onMouseEnter: id && onHover ? () => onHover(id) : undefined,
      onMouseLeave: id && onHover ? () => onHover(null) : undefined,
      style: id ? { cursor: 'pointer' } : undefined,
    };
  };

  const sorted = useMemo(() => [...prims].sort((a, b) => rank(a) - rank(b)), [prims]);

  return (
    <svg viewBox={vb.join(' ')} className="w-full" style={{ maxHeight }} role="img">
      <defs>
        <pattern id={hatchId} patternUnits="userSpaceOnUse" width={fontSize * 0.55} height={fontSize * 0.55}
                 patternTransform="rotate(45)">
          <rect width={fontSize * 0.55} height={fontSize * 0.55} fill={BG} />
          <line x1={0} y1={0} x2={0} y2={fontSize * 0.55} stroke={WALL} strokeWidth={0.6}
                vectorEffect="non-scaling-stroke" opacity={0.45} />
        </pattern>
      </defs>
      {sorted.map((p, i) => {
        if (p.t === 'poly') {
          const d = p.pts.map(([x, y], j) => `${j ? 'L' : 'M'}${X(x)} ${Y(y)}`).join(' ') + (p.closed ? ' Z' : '');
          // An open polyline is a line, never a filled shape (SVG would close and fill it).
          return <path key={i} d={d} {...common(p.layer, p.id)} {...(p.closed ? {} : { fill: 'none' })} />;
        }
        if (p.t === 'circle') {
          return <circle key={i} cx={X(p.c[0])} cy={Y(p.c[1])} r={p.r * S} {...common(p.layer, p.id, true)} />;
        }
        if (p.t === 'dim') {
          const a2 = [p.a[0] + p.off[0], p.a[1] + p.off[1]];
          const b2 = [p.b[0] + p.off[0], p.b[1] + p.off[1]];
          const mid = [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2];
          const vertical = Math.abs(a2[0] - b2[0]) < Math.abs(a2[1] - b2[1]);
          const tick = fontSize * 0.35;
          const st = { stroke: WALL, strokeWidth: 0.6, vectorEffect: 'non-scaling-stroke' as const };
          return (
            <g key={i}>
              <line x1={X(p.a[0])} y1={Y(p.a[1])} x2={X(a2[0])} y2={Y(a2[1])} {...st} opacity={0.6} />
              <line x1={X(p.b[0])} y1={Y(p.b[1])} x2={X(b2[0])} y2={Y(b2[1])} {...st} opacity={0.6} />
              <line x1={X(a2[0])} y1={Y(a2[1])} x2={X(b2[0])} y2={Y(b2[1])} {...st} />
              {[a2, b2].map((q, j) => (
                <line key={j} {...st}
                      x1={X(q[0]) - (vertical ? tick : tick * 0.7)} y1={Y(q[1]) - (vertical ? tick * 0.7 : -tick)}
                      x2={X(q[0]) + (vertical ? tick : tick * 0.7)} y2={Y(q[1]) + (vertical ? tick * 0.7 : -tick)} />
              ))}
              {(() => {
                // A dimension shorter than its own text puts the text beside it, not across
                // whatever the dimension is measuring.
                const span = Math.hypot(X(b2[0]) - X(a2[0]), Y(b2[1]) - Y(a2[1]));
                const textLen = p.text.length * fontSize * 0.6;
                if (!vertical && span < textLen) {
                  const right = X(b2[0]) >= X(a2[0]) ? b2 : a2;
                  return (
                    <text x={X(right[0]) + fontSize * 0.6} y={Y(right[1])} fontSize={fontSize} fill={WALL}
                          textAnchor="start" dominantBaseline="middle">{p.text}</text>
                  );
                }
                const right = vertical && p.side === 'right';
                return (
                  <text x={X(mid[0]) + (vertical ? (right ? 1 : -1) * fontSize * 0.4 : 0)} y={Y(mid[1]) - (vertical ? 0 : fontSize * 0.35)}
                        fontSize={fontSize} fill={WALL} textAnchor={vertical ? (right ? 'start' : 'end') : 'middle'}
                        dominantBaseline={vertical ? 'middle' : 'auto'}>
                    {p.text}
                  </text>
                );
              })()}
            </g>
          );
        }
        const color = p.layer === 'PASSAGE_O' ? OX : p.layer === 'PASSAGE_F' ? FU : p.layer === 'BAD' ? BAD : WALL;
        return (
          <text key={i} x={X(p.at[0])} y={Y(p.at[1])} fontSize={fontSize} fill={color} textAnchor={p.anchor}>
            {p.text}
          </text>
        );
      })}
    </svg>
  );
}

export default InjectorDrawing;
