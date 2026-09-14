/**
 * The presentation figure. Not the scope.
 *
 * `DaqPlot` is a live-telemetry instrument: thick strokes, bright grid, uPlot
 * redrawing at tick rate. That is the right design for watching a stand and
 * the wrong one for a figure somebody puts in front of a review board, which
 * is what the study produces. So there are two plots for two jobs rather than
 * one plot with a mode.
 *
 * The visual language here is fixed by what the study is *for*: GN2 against
 * helium, ox against fuel. Gas is hue, tank is line style — solid ox, dashed
 * fuel — so a glance separates gas first and tank second, and nothing is
 * carried by colour alone. Every series is direct-labelled at its endpoint as
 * well as in the legend, because a reader tracing four traces should never
 * have to look away from the line to find out what it is.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

export interface Series {
  key: string;
  label: string;
  color: string;
  /** Dashed. Reserved for the fuel side of a gas already drawn solid. */
  dashed?: boolean;
  t: number[];
  v: number[];
}

/** A horizontal or vertical annotation — lockup, mains open, a limit. */
export interface Rule {
  y?: number;
  x?: number;
  label: string;
}

const W = 920;
const H = 340;
const L = 64;   // left gutter: y tick labels
const R = 768;  // plot right edge; the rest is direct-label room
const T = 22;
const B = 296;

const GRID = '#26262f';
const AXIS = '#4a4a58';
const INK2 = '#9a9aa8';
const INK3 = '#7a7a8a';
const SURFACE = '#141414';

/** Tick steps a person would have chosen: 1, 2, 5 and their decades. */
function ticks(lo: number, hi: number, want = 6): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / want;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(v);
  return out;
}

/** Endpoint labels that would overlap, pushed apart instead of stacked.
 *
 *  The gap is 16 against a 12px face rather than something tighter: two labels
 *  a hair apart read as one smeared line, which is worse than either being
 *  slightly off its own endpoint. */
function unstack(points: { y: number; i: number }[], gap = 16): number[] {
  const order = [...points].sort((a, b) => a.y - b.y);
  const placed: number[] = [];
  let last = -Infinity;
  for (const p of order) {
    const y = Math.max(p.y, last + gap);
    placed[p.i] = y;
    last = y;
  }
  return placed;
}

export function StudyChart({
  title,
  caption,
  series,
  yLabel,
  xLabel = 'seconds from ignition',
  rules = [],
  area = false,
}: {
  title: string;
  caption: string;
  series: Series[];
  yLabel: string;
  xLabel?: string;
  rules?: Rule[];
  /** Gradient wash under the traces. Only legible with one or two series. */
  area?: boolean;
}) {
  const host = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const drawn = series.filter((s) => s.t.length > 1);

  const box = useMemo(() => {
    if (!drawn.length) return null;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const s of drawn) {
      for (const t of s.t) {
        if (t < x0) x0 = t;
        if (t > x1) x1 = t;
      }
      for (const v of s.v) {
        if (Number.isFinite(v)) {
          if (v < y0) y0 = v;
          if (v > y1) y1 = v;
        }
      }
    }
    for (const rule of rules) {
      if (rule.y !== undefined) {
        y0 = Math.min(y0, rule.y);
        y1 = Math.max(y1, rule.y);
      }
    }
    // A flat trace still needs a band to sit in.
    if (!(y1 > y0)) {
      y0 -= 1;
      y1 += 1;
    }
    const pad = (y1 - y0) * 0.12;
    return { x0, x1: x1 > x0 ? x1 : x0 + 1, y0: y0 - pad, y1: y1 + pad };
  }, [drawn, rules]);

  const sx = useCallback(
    (t: number) => (box ? L + ((t - box.x0) / (box.x1 - box.x0)) * (R - L) : L),
    [box],
  );
  const sy = useCallback(
    (v: number) => (box ? B - ((v - box.y0) / (box.y1 - box.y0)) * (B - T) : B),
    [box],
  );

  const ends = useMemo(() => {
    if (!box) return [];
    const raw = drawn.map((s, i) => ({ y: sy(s.v[s.v.length - 1]) - 4, i }));
    const placed = unstack(raw);
    return drawn.map((s, i) => ({
      x: sx(s.t[s.t.length - 1]),
      y: sy(s.v[s.v.length - 1]),
      label: placed[i],
      series: s,
    }));
  }, [drawn, box, sx, sy]);

  /** Nearest sample to the cursor, per series, for the read-out. */
  const readout = useMemo(() => {
    if (hover === null || !box) return null;
    const at = box.x0 + ((hover - L) / (R - L)) * (box.x1 - box.x0);
    const rows = drawn.map((s) => {
      let best = 0;
      for (let i = 1; i < s.t.length; i += 1) {
        if (Math.abs(s.t[i] - at) < Math.abs(s.t[best] - at)) best = i;
      }
      return { s, t: s.t[best], v: s.v[best] };
    });
    return { at, rows };
  }, [hover, box, drawn]);

  const track = (event: React.MouseEvent<SVGSVGElement>) => {
    const svg = host.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * W;
    setHover(x >= L && x <= R ? x : null);
  };

  if (!box || !drawn.length) return null;

  const yTicks = ticks(box.y0, box.y1);
  const xTicks = ticks(box.x0, box.x1, 7);

  return (
    <figure
      className="rounded-xl border p-6"
      style={{
        margin: 0,
        borderColor: 'rgba(255,255,255,0.07)',
        background:
          'linear-gradient(180deg, rgba(30,30,38,0.62) 0%, rgba(20,20,26,0.5) 100%)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
      }}
    >
      <figcaption className="mb-3">
        <h3
          className="text-[15.5px] font-semibold"
          style={{ color: '#e8e8ee', letterSpacing: '-0.012em', textWrap: 'balance' }}
        >
          {title}
        </h3>
      </figcaption>

      <div className="mb-2.5 flex flex-wrap gap-x-4 gap-y-1.5 text-[12.5px]" style={{ color: INK2 }}>
        {drawn.map((s) => (
          <span key={s.key} className="inline-flex items-center" style={{ color: s.color }}>
            <i
              aria-hidden
              className="mr-1.5 inline-block align-middle"
              style={{
                width: 22,
                borderTop: `2.5px ${s.dashed ? 'dashed' : 'solid'} currentColor`,
                opacity: s.dashed ? 0.75 : 1,
              }}
            />
            <span style={{ color: INK2 }}>{s.label}</span>
          </span>
        ))}
      </div>

      <div className="-mx-1.5 overflow-x-auto">
        <svg
          ref={host}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${title}. ${caption}`}
          style={{ display: 'block', minWidth: 660, width: '100%', height: 'auto' }}
          onMouseMove={track}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            {drawn.map((s) => (
              <linearGradient key={s.key} id={`wash-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity="0.18" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>

          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line x1={L} y1={sy(v)} x2={R} y2={sy(v)} stroke={GRID} strokeWidth={1} />
              <text
                x={L - 10}
                y={sy(v) + 4}
                fill={INK3}
                fontSize={12}
                textAnchor="end"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {Math.abs(v) >= 1000 ? Math.round(v) : Number(v.toFixed(1))}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text
              key={`x${t}`}
              x={sx(t)}
              y={B + 20}
              fill={INK3}
              fontSize={12}
              textAnchor="middle"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {Number(t.toFixed(t < 10 ? 1 : 0))}
            </text>
          ))}
          <line x1={L} y1={B} x2={R} y2={B} stroke={AXIS} strokeWidth={1} />
          <text x={L - 10} y={T - 7} fill={INK3} fontSize={11} textAnchor="end">
            {yLabel}
          </text>
          <text x={(L + R) / 2} y={H - 7} fill={INK3} fontSize={12} textAnchor="middle">
            {xLabel}
          </text>

          {rules.map((rule, i) =>
            rule.y !== undefined ? (
              <g key={`r${i}`}>
                <line
                  x1={L}
                  y1={sy(rule.y)}
                  x2={R}
                  y2={sy(rule.y)}
                  stroke={INK3}
                  strokeWidth={1.5}
                  strokeDasharray="2 4"
                  opacity={0.8}
                />
                {/* Inside the plot, not in the right gutter: that gutter is
                    where the series label themselves, and a reference line
                    sitting at the value a trace ends on -- lockup, which is
                    exactly where they do end -- collided with every one. */}
                <text x={L + 7} y={sy(rule.y) - 6} fill={INK3} fontSize={11}>
                  {rule.label}
                </text>
              </g>
            ) : (
              <g key={`r${i}`}>
                <line
                  x1={sx(rule.x ?? 0)}
                  y1={T}
                  x2={sx(rule.x ?? 0)}
                  y2={B}
                  stroke={INK3}
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  opacity={0.7}
                />
                <text x={sx(rule.x ?? 0) + 6} y={T + 13} fill={INK3} fontSize={11}>
                  {rule.label}
                </text>
              </g>
            ),
          )}

          {area &&
            drawn.map((s) => (
              <path
                key={`a${s.key}`}
                d={
                  `M${sx(s.t[0])},${B} ` +
                  s.t.map((t, i) => `L${sx(t).toFixed(1)},${sy(s.v[i]).toFixed(1)}`).join(' ') +
                  ` L${sx(s.t[s.t.length - 1])},${B} Z`
                }
                fill={`url(#wash-${s.key})`}
              />
            ))}

          {drawn.map((s) => (
            <path
              key={s.key}
              d={'M' + s.t.map((t, i) => `${sx(t).toFixed(1)},${sy(s.v[i]).toFixed(1)}`).join('L')}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray={s.dashed ? '5 4' : undefined}
              opacity={s.dashed ? 0.75 : 1}
            />
          ))}

          {ends.map((e) => (
            <g key={`e${e.series.key}`}>
              {/* The ring is the surface colour, so crossing traces stay legible. */}
              <circle cx={e.x} cy={e.y} r={3.5} fill={e.series.color} stroke={SURFACE} strokeWidth={1.5} />
              <text x={e.x + 9} y={e.label} fill={e.series.color} fontSize={12} fontWeight={600}>
                {e.series.label}
              </text>
            </g>
          ))}

          {readout && (
            <g pointerEvents="none">
              <line x1={hover ?? 0} y1={T} x2={hover ?? 0} y2={B} stroke={INK2} strokeWidth={1} opacity={0.55} />
              {readout.rows.map((row) => (
                <circle
                  key={`h${row.s.key}`}
                  cx={sx(row.t)}
                  cy={sy(row.v)}
                  r={4}
                  fill={row.s.color}
                  stroke={SURFACE}
                  strokeWidth={2}
                />
              ))}
            </g>
          )}
        </svg>
      </div>

      {readout && (
        <div
          className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px]"
          style={{ color: INK2, fontVariantNumeric: 'tabular-nums' }}
        >
          <span style={{ color: '#e8e8ee', fontWeight: 600 }}>t = {readout.at.toFixed(2)} s</span>
          {readout.rows.map((row) => (
            <span key={`v${row.s.key}`}>
              <span style={{ color: row.s.color }}>{row.s.label}</span>{' '}
              <span style={{ color: '#e8e8ee' }}>{row.v.toFixed(1)}</span>
            </span>
          ))}
        </div>
      )}

      <p
        className="mt-3 text-[13px] leading-relaxed"
        style={{ color: INK2, maxWidth: '80ch' }}
      >
        {caption}
      </p>
    </figure>
  );
}
