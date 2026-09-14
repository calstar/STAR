/**
 * The centerline sketch editor.
 *
 * A small CAD sketch of one run: draw the centerline leg by leg with a live
 * length readout, put a bend of a stated radius on any corner, set any
 * length or radius from its dimension, split the run where the bore
 * changes, and see the inner wall drawn either side of the line as you go.
 * The origin is where the run leaves the upstream port, so the first leg's
 * direction is the run's orientation.
 *
 * Everything here is a view on `model.ts`; nothing about lengths, tangents,
 * sections or units lives in this file.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addLeg, bendableVertices, boreAt, fallMm, fromMm, legDirection, legLengthMm,
  pointAlong, removeBend, setBend, setLegLength, setSectionBore, splitAt, startOf,
  straightLengthMm, toMm, totalLengthMm, undoLeg, ORIGIN,
} from './model';
import type { Point, Sketch, Unit } from './model';
import { SizeChart } from './SizeChart';
import { NumberField } from '../NumberField';

type Tool = 'line' | 'bend' | 'dimension' | 'split';

const W = 560, H = 360, PAD = 40;
const CENTER = '#e2e8f0';
const WALL = '#38bdf8';
const DIM = '#f59e0b';
const MUTED = '#64748b';

const field = 'rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]';
const tb = (on: boolean) =>
  `rounded px-2 py-0.5 text-[11px] ${on ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'}`;

/**
 * A number for a person to read, and to type over.
 *
 * Trailing zeros are dropped and the precision is finer than it was, because
 * every one of these strings is also the starting text of an editable field:
 * `toFixed(2)` on inches turned a 0.402" bore into "0.40" the moment it was
 * displayed, and whole millimetres could not say 12.7 at all.
 */
const fmt = (mm: number, unit: Unit) => {
  const dp = unit === 'mm' ? 1 : unit === 'in' ? 3 : 4;
  return String(Number(fromMm(mm, unit).toFixed(dp)));
};
const unitLabel = (u: Unit) => (u === 'in' ? '″' : u === 'mm' ? ' mm' : ' m');

export function SketchEditor({ sketch, onChange, readOnly }: {
  sketch: Sketch;
  onChange: (s: Sketch) => void;
  readOnly: boolean;
}) {
  const [tool, setTool] = useState<Tool>('line');
  const [cursor, setCursor] = useState<Point | null>(null);   // flow-space (mm)
  const [drawing, setDrawing] = useState(false);
  const [prompt, setPrompt] = useState<
    | { kind: 'bend'; at: number; value: string }
    | { kind: 'leg'; at: number; value: string }
    | { kind: 'bore'; section: string | null; value: string }
    | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dimOffsets, setDimOffsets] = useState<Record<string, number>>({});
  const [radiusMode, setRadiusMode] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const unit = sketch.unit;

  // ── Fit the drawing to the frame ──────────────────────────────────────────
  // Recomputed on each committed change so the scale does not swim under the
  // cursor mid-leg; the preview leg is allowed to run off the frame.
  const view = useMemo(() => {
    const pts: Point[] = [ORIGIN, ...sketch.legs.map(l => l.to)];
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const spanX = Math.max(maxX - minX, 200), spanY = Math.max(maxY - minY, 200);
    const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY, 1.0);
    const ox = PAD + ((W - 2 * PAD) - spanX * scale) / 2 - minX * scale;
    const oy = PAD + ((H - 2 * PAD) - spanY * scale) / 2 - minY * scale;
    return { scale, ox, oy };
  }, [sketch.legs]);
  const toScreen = useCallback((p: Point) => ({ x: view.ox + p.x * view.scale, y: view.oy + p.y * view.scale }), [view]);
  const toFlow = useCallback((sx: number, sy: number) => ({ x: (sx - view.ox) / view.scale, y: (sy - view.oy) / view.scale }), [view]);

  const mouseFlow = (e: React.MouseEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return toFlow((e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height));
  };

  // Escape ends the leg being drawn or the number being typed -- and stops
  // there. The dialog around this listens for Escape too, and let through it
  // closed the whole dialog with the sketch in it, which is the one key a
  // person drawing presses most. Capture phase, so this runs first.
  const drawingRef = useRef(false); drawingRef.current = drawing;
  const promptRef = useRef<typeof prompt>(null); promptRef.current = prompt;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (drawingRef.current || promptRef.current) {
        e.stopImmediatePropagation();
        e.preventDefault();
        setDrawing(false);
        setPrompt(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // ── The run as drawn: centerline path, inner walls, dimensions ───────────
  const samples = useMemo(() => {
    const total = totalLengthMm(sketch);
    const n = 160;
    const out: { along: number; p: Point; dir: Point }[] = [];
    for (let i = 0; i <= n; i++) {
      const along = (total * i) / n;
      const at = pointAlong(sketch, along);
      if (at) out.push({ along, ...at });
    }
    return out;
  }, [sketch]);

  const centerPath = useMemo(() => {
    if (!samples.length) return '';
    return samples.map((s, i) => `${i ? 'L' : 'M'} ${toScreen(s.p).x.toFixed(1)},${toScreen(s.p).y.toFixed(1)}`).join(' ');
  }, [samples, toScreen]);

  // Inner walls: the centerline offset ± bore/2, per sample, with a step
  // wherever the bore changes so the envelope stays closed.
  const wallPaths = useMemo(() => {
    if (!samples.length || sketch.boreMm <= 0) return { a: '', b: '' };
    const side = (sign: 1 | -1) => samples.map((s, i) => {
      const half = boreAt(sketch, s.along) / 2;
      const p = toScreen({ x: s.p.x - s.dir.y * half * sign, y: s.p.y + s.dir.x * half * sign });
      return `${i ? 'L' : 'M'} ${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    }).join(' ');
    return { a: side(1), b: side(-1) };
  }, [samples, sketch, toScreen]);

  const nearestAlong = (p: Point): { along: number; distPx: number } | null => {
    if (!samples.length) return null;
    let best = samples[0], bestD = Infinity;
    for (const s of samples) {
      const d = Math.hypot(s.p.x - p.x, s.p.y - p.y);
      if (d < bestD) { bestD = d; best = s; }
    }
    return { along: best.along, distPx: bestD * view.scale };
  };

  // ── Tool actions ─────────────────────────────────────────────────────────
  const onClick = (e: React.MouseEvent) => {
    if (readOnly || prompt) return;
    const p = mouseFlow(e);
    setError(null);
    if (tool === 'line') {
      if (!drawing) { setDrawing(true); return; }
      onChange(addLeg(sketch, p, e.altKey));
      return;
    }
    if (tool === 'split') {
      const hit = nearestAlong(p);
      if (hit && hit.distPx < 14) {
        const next = splitAt(sketch, hit.along);
        if (next !== sketch) onChange(next);
      }
    }
  };

  const commitPrompt = () => {
    if (!prompt) return;
    const v = Number(prompt.value);
    if (!(v > 0)) { setPrompt(null); return; }
    if (prompt.kind === 'bend') {
      const next = setBend(sketch, prompt.at, toMm(v, unit));
      if (!next) setError('That radius does not fit: a bend needs its tangent length on both legs.');
      else onChange(next);
    } else if (prompt.kind === 'leg') {
      onChange(setLegLength(sketch, prompt.at, toMm(v, unit)));
    } else {
      const bore = radiusMode ? 2 * toMm(v, unit) : toMm(v, unit);
      onChange(setSectionBore(sketch, prompt.section, bore));
    }
    setPrompt(null);
  };

  const bendDefault = () => fmt(sketch.boreMm > 0 ? 3 * sketch.boreMm : toMm(2, 'in'), unit);

  // ── Preview of the leg being drawn ───────────────────────────────────────
  const previewFrom = sketch.legs.length ? sketch.legs[sketch.legs.length - 1].to : ORIGIN;
  const preview = drawing && cursor && tool === 'line'
    ? addLeg({ ...sketch, legs: [] , bends: [], sections: [] }, { x: cursor.x - previewFrom.x, y: cursor.y - previewFrom.y })
    : null;
  const previewEnd = preview?.legs[0] ? { x: previewFrom.x + preview.legs[0].to.x, y: previewFrom.y + preview.legs[0].to.y } : null;
  const previewLen = previewEnd ? Math.hypot(previewEnd.x - previewFrom.x, previewEnd.y - previewFrom.y) : 0;

  const total = totalLengthMm(sketch);
  const fall = fallMm(sketch);
  const first = sketch.legs.length ? legDirection(sketch, 0) : null;
  const orientation = !first ? '—' : Math.abs(first.x) > Math.abs(first.y) ? 'leaves sideways' : first.y > 0 ? 'leaves downward' : 'leaves upward';

  return (
    <div className="space-y-1.5">
      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-1">
        {(['line', 'bend', 'dimension', 'split'] as Tool[]).map(t => (
          <button key={t} disabled={readOnly} onClick={() => { setTool(t); setDrawing(false); setPrompt(null); }} className={tb(tool === t)}
            title={t === 'line' ? 'Line: click to start at the origin, move, click to end each leg. Esc ends. Alt for a free angle.'
              : t === 'bend' ? 'Bend: click a corner dot and give the centerline radius.'
              : t === 'dimension' ? 'Dimension: click a length or a radius to change it.'
              : 'Split: click the run where the bore changes.'}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-[var(--color-border)]" />
        <select value={unit} disabled={readOnly} onChange={e => onChange({ ...sketch, unit: e.target.value as Unit })} className={field}>
          <option value="in">inches</option><option value="mm">mm</option><option value="m">metres</option>
        </select>
        <label className="ml-1 flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)]">
          <input type="checkbox" checked={radiusMode} disabled={readOnly} onChange={e => setRadiusMode(e.target.checked)} />
          radius
        </label>
        <span className="mx-1 h-4 w-px bg-[var(--color-border)]" />
        <label className="flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)]">
          inner {radiusMode ? 'radius' : 'diameter'}
          <NumberField readOnly={readOnly} className={`${field} w-[64px]`} placeholder="—"
            value={sketch.boreMm > 0 ? fmt(radiusMode ? sketch.boreMm / 2 : sketch.boreMm, unit) : ''}
            onCommit={v => onChange(setSectionBore(sketch, null, radiusMode ? 2 * toMm(v, unit) : toMm(v, unit)))} />
          {unitLabel(unit).trim()}
        </label>
        <span className="ml-auto" />
        <button disabled={readOnly || !sketch.legs.length} onClick={() => onChange(undoLeg(sketch))} className={tb(false)}>undo leg</button>
        <button disabled={readOnly || !sketch.legs.length} onClick={() => onChange({ ...sketch, legs: [], bends: [], sections: [] })} className={tb(false)}>clear</button>
      </div>

      {/* ── Canvas ── */}
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" style={{ aspectRatio: `${W}/${H}`, cursor: readOnly ? 'default' : 'crosshair' }}
        className="rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)]"
        onMouseMove={e => setCursor(mouseFlow(e))} onMouseLeave={() => setCursor(null)}
        onClick={onClick} onDoubleClick={() => setDrawing(false)}>
        <defs>
          <pattern id="sk-grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.6" fill="#1e293b" />
          </pattern>
          <marker id="sk-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={DIM} />
          </marker>
        </defs>
        <rect width={W} height={H} fill="url(#sk-grid)" />

        {/* origin */}
        {(() => { const o = toScreen(ORIGIN); return (
          <g>
            <circle cx={o.x} cy={o.y} r={4} fill="none" stroke={MUTED} strokeWidth={1.2} />
            <line x1={o.x - 7} y1={o.y} x2={o.x + 7} y2={o.y} stroke={MUTED} strokeWidth={1} />
            <line x1={o.x} y1={o.y - 7} x2={o.x} y2={o.y + 7} stroke={MUTED} strokeWidth={1} />
            <text x={o.x + 8} y={o.y - 6} fontSize={8} fill={MUTED} fontFamily="monospace">origin · upstream port</text>
          </g>); })()}

        {/* inner walls */}
        {wallPaths.a && <path d={wallPaths.a} fill="none" stroke={WALL} strokeWidth={1} opacity={0.8} />}
        {wallPaths.b && <path d={wallPaths.b} fill="none" stroke={WALL} strokeWidth={1} opacity={0.8} />}
        {/* a step where the bore changes, so the envelope is closed */}
        {sketch.boreMm > 0 && sketch.sections.map(sec => {
          const at = pointAlong(sketch, sec.fromMm); if (!at) return null;
          const before = boreAt(sketch, sec.fromMm - 1e-6) / 2, after = sec.boreMm / 2;
          const n = { x: -at.dir.y, y: at.dir.x };
          const a1 = toScreen({ x: at.p.x + n.x * before, y: at.p.y + n.y * before }), a2 = toScreen({ x: at.p.x + n.x * after, y: at.p.y + n.y * after });
          const b1 = toScreen({ x: at.p.x - n.x * before, y: at.p.y - n.y * before }), b2 = toScreen({ x: at.p.x - n.x * after, y: at.p.y - n.y * after });
          return <g key={sec.id} stroke={WALL} strokeWidth={1}><line x1={a1.x} y1={a1.y} x2={a2.x} y2={a2.y} /><line x1={b1.x} y1={b1.y} x2={b2.x} y2={b2.y} /></g>;
        })}

        {/* centerline */}
        {centerPath && <path d={centerPath} fill="none" stroke={CENTER} strokeWidth={1.6} strokeDasharray="10 3 2 3" />}

        {/* preview leg */}
        {previewEnd && (() => { const a = toScreen(previewFrom), b = toScreen(previewEnd); return (
          <g>
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={CENTER} strokeWidth={1.2} strokeDasharray="4 3" opacity={0.7} />
            <text x={(a.x + b.x) / 2 + 6} y={(a.y + b.y) / 2 - 6} fontSize={10} fill={CENTER} fontFamily="monospace">{fmt(previewLen, unit)}{unitLabel(unit)}</text>
          </g>); })()}

        {/* dimensions: one per straight, one per bend */}
        {sketch.legs.map((_, i) => {
          const a = startOf(sketch, i), b = sketch.legs[i].to;
          const d = legDirection(sketch, i);
          const n = { x: -d.y, y: d.x };
          const off = (dimOffsets[`leg_${i}`] ?? 22) + (sketch.boreMm > 0 ? (boreAt(sketch, 0) / 2) * view.scale : 0);
          const A = toScreen(a), B = toScreen(b);
          const p1 = { x: A.x + n.x * off, y: A.y + n.y * off }, p2 = { x: B.x + n.x * off, y: B.y + n.y * off };
          const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
          const L = straightLengthMm(sketch, i);
          const raw = legLengthMm(sketch, i);
          const editing = prompt?.kind === 'leg' && prompt.at === i;
          return (
            <g key={`dim-${i}`} style={{ cursor: tool === 'dimension' && !readOnly ? 'pointer' : 'default' }}
              onClick={e => { if (tool !== 'dimension' || readOnly) return; e.stopPropagation(); setPrompt({ kind: 'leg', at: i, value: fmt(raw, unit) }); }}
              onMouseDown={e => { if (tool !== 'dimension' || e.button !== 0) return; e.stopPropagation();
                const start = e.clientY * n.y + e.clientX * n.x; const base = dimOffsets[`leg_${i}`] ?? 22;
                const move = (ev: MouseEvent) => setDimOffsets(o => ({ ...o, [`leg_${i}`]: base + ((ev.clientY * n.y + ev.clientX * n.x) - start) }));
                const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
                window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); }}>
              <line x1={A.x} y1={A.y} x2={p1.x + n.x * 4} y2={p1.y + n.y * 4} stroke={DIM} strokeWidth={0.6} opacity={0.6} />
              <line x1={B.x} y1={B.y} x2={p2.x + n.x * 4} y2={p2.y + n.y * 4} stroke={DIM} strokeWidth={0.6} opacity={0.6} />
              <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={DIM} strokeWidth={0.8} markerStart="url(#sk-arrow)" markerEnd="url(#sk-arrow)" />
              {editing ? (
                <foreignObject x={mid.x - 34} y={mid.y - 10} width={70} height={20}>
                  <input autoFocus readOnly={readOnly} className={`${field} w-full`} value={prompt.value}
                    onChange={e => setPrompt({ ...prompt, value: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') commitPrompt(); if (e.key === 'Escape') setPrompt(null); }}
                    onBlur={commitPrompt} onClick={e => e.stopPropagation()} />
                </foreignObject>
              ) : (
                <text x={mid.x + n.x * 8} y={mid.y + n.y * 8 + 3} fontSize={10} fill={DIM} fontFamily="monospace" textAnchor="middle">
                  {fmt(raw, unit)}{unitLabel(unit)}{Math.abs(L - raw) > 1e-6 ? ` (${fmt(L, unit)} straight)` : ''}
                </text>
              )}
            </g>
          );
        })}
        {sketch.bends.map(b => {
          const v = sketch.legs[b.atLeg].to;
          const V = toScreen(v);
          const editing = prompt?.kind === 'bend' && prompt.at === b.atLeg;
          return (
            <g key={`bend-${b.atLeg}`} style={{ cursor: (tool === 'dimension' || tool === 'bend') && !readOnly ? 'pointer' : 'default' }}
              onClick={e => { if (readOnly || (tool !== 'dimension' && tool !== 'bend')) return; e.stopPropagation(); setPrompt({ kind: 'bend', at: b.atLeg, value: fmt(b.radiusMm, unit) }); }}>
              {editing ? (
                <foreignObject x={V.x + 6} y={V.y - 10} width={70} height={20}>
                  <input autoFocus readOnly={readOnly} className={`${field} w-full`} value={prompt.value}
                    onChange={e => setPrompt({ ...prompt, value: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') commitPrompt(); if (e.key === 'Escape') setPrompt(null); }}
                    onBlur={commitPrompt} onClick={e => e.stopPropagation()} />
                </foreignObject>
              ) : (
                <text x={V.x + 8} y={V.y + 12} fontSize={10} fill={DIM} fontFamily="monospace">R {fmt(b.radiusMm, unit)}{unitLabel(unit)}</text>
              )}
            </g>
          );
        })}

        {/* the radius being typed for a corner that has no bend yet */}
        {prompt?.kind === 'bend' && !sketch.bends.some(b => b.atLeg === prompt.at) && (() => {
          const V = toScreen(sketch.legs[prompt.at].to);
          return (
            <foreignObject x={V.x + 6} y={V.y - 10} width={70} height={20}>
              <input autoFocus readOnly={readOnly} className={`${field} w-full`} value={prompt.value}
                onChange={e => setPrompt({ ...prompt, value: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter') commitPrompt(); if (e.key === 'Escape') setPrompt(null); }}
                onBlur={commitPrompt} onClick={e => e.stopPropagation()} />
            </foreignObject>
          );
        })()}

        {/* corner dots the bend tool can take */}
        {bendableVertices(sketch).map(i => {
          const V = toScreen(sketch.legs[i].to);
          const has = sketch.bends.some(b => b.atLeg === i);
          return (
            <circle key={`v-${i}`} cx={V.x} cy={V.y} r={tool === 'bend' ? 6 : 3}
              fill={has ? DIM : '#0f172a'} stroke={tool === 'bend' ? DIM : MUTED} strokeWidth={1.2}
              style={{ cursor: tool === 'bend' && !readOnly ? 'pointer' : 'default' }}
              onClick={e => { if (tool !== 'bend' || readOnly) return; e.stopPropagation();
                if (has && e.shiftKey) { onChange(removeBend(sketch, i)); return; }
                setPrompt({ kind: 'bend', at: i, value: has ? fmt(sketch.bends.find(b => b.atLeg === i)!.radiusMm, unit) : bendDefault() }); }}>
              <title>{has ? 'click to change the radius · shift-click to remove' : 'click to add a bend'}</title>
            </circle>
          );
        })}

        {/* section bores: Ø on each stretch, click to change */}
        {sketch.boreMm > 0 && [{ id: null as string | null, fromMm: 0 }, ...sketch.sections].map((sec, k, all) => {
          const to = k + 1 < all.length ? all[k + 1].fromMm : total;
          const at = pointAlong(sketch, (sec.fromMm + to) / 2); if (!at) return null;
          const bore = boreAt(sketch, (sec.fromMm + to) / 2);
          const n = { x: -at.dir.y, y: at.dir.x };
          const off = (bore / 2) * view.scale + 12;
          const P = toScreen(at.p);
          const x = P.x - n.x * off, y = P.y - n.y * off;
          const editing = prompt?.kind === 'bore' && prompt.section === sec.id;
          return (
            <g key={sec.id ?? 'base'} style={{ cursor: tool === 'dimension' && !readOnly ? 'pointer' : 'default' }}
              onClick={e => { if (tool !== 'dimension' || readOnly) return; e.stopPropagation(); setPrompt({ kind: 'bore', section: sec.id, value: fmt(radiusMode ? bore / 2 : bore, unit) }); }}>
              {editing ? (
                <foreignObject x={x - 34} y={y - 10} width={70} height={20}>
                  <input autoFocus readOnly={readOnly} className={`${field} w-full`} value={prompt.value}
                    onChange={e => setPrompt({ ...prompt, value: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') commitPrompt(); if (e.key === 'Escape') setPrompt(null); }}
                    onBlur={commitPrompt} onClick={e => e.stopPropagation()} />
                </foreignObject>
              ) : (
                <text x={x} y={y + 3} fontSize={10} fill={WALL} fontFamily="monospace" textAnchor="middle">
                  {radiusMode ? 'R' : 'Ø'} {fmt(radiusMode ? bore / 2 : bore, unit)}{unitLabel(unit)}
                </text>
              )}
            </g>
          );
        })}

        {/* split cursor */}
        {tool === 'split' && cursor && (() => { const hit = nearestAlong(cursor); if (!hit || hit.distPx > 14) return null; const at = pointAlong(sketch, hit.along); if (!at) return null; const P = toScreen(at.p); return <circle cx={P.x} cy={P.y} r={5} fill="none" stroke={WALL} strokeWidth={1.5} />; })()}
      </svg>

      {/* ── Readout and legend ── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-[var(--color-text-muted)]">
        <span><span style={{ color: CENTER }}>— · —</span> centerline</span>
        <span><span style={{ color: WALL }}>——</span> inner wall</span>
        <span><span style={{ color: DIM }}>|←→|</span> dimension</span>
        <span className="ml-auto font-mono text-[var(--color-text-secondary)]">
          {sketch.legs.length ? `${fmt(total, unit)}${unitLabel(unit)} of run · fall ${fmt(fall, unit)}${unitLabel(unit)} · ${orientation}` : 'click in the frame to start at the origin'}
          {' · '}{sketch.bends.length} bend{sketch.bends.length === 1 ? '' : 's'}
        </span>
      </div>
      {error && <p className="text-[10px] text-amber-500/90">{error}</p>}

      <SizeChart unit={unit} readOnly={readOnly} onPick={(mm) => onChange(setSectionBore(sketch, null, mm))} />
    </div>
  );
}
