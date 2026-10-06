import './hero.css';
import { memo, useCallback, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { LayerXResult } from '../../../api/layerx';
import { MONO, SANS, textWidth } from '../charts/measure';
import { useOptionalTimeStore, useTimeOf } from '../time/hooks';
import { formatT } from '../time/markers';
import type { TimeState } from '../time/store';
import { NotComputed } from '../ui';
import { numText, useUnits, type Units } from '../units';
import { HoverCard } from './Card';
import { colorbarTicks, flowWidth, pressureScale, seqColor, type PressureScale, type ThemeName } from './colormap';
import { at } from './contract';
import { INLINE, lineName, parseDrawing, SWITCHED, type DSymbol, type Drawing, type DrawingDocument } from './drawing';
import { useCursorIndexOr, useDrawingDocument, useLxTheme, useWidth } from './hooks';
import { fitScale, layoutSchematic, pathOf, type Dir, type PlacedSymbol, type SchematicLayout } from './layout';
import { buildNetView, bottleOf, liquidPath, tankSides, type NetView } from './network';
import { lineRows, symbolRows, vesselFigure } from './readout';
import { bottleShape, bowtie, CHAMBER_PATH, INK, INK_QUIET, PAPER, REG_H, REG_W, tankShape, VALVE_H, VALVE_W } from './shapes';
import { SymbolShape } from './symbols';

/**
 * The feed system as the drawing has it, live at the cursor (GUI-SPEC "Hero"): every line coloured
 * by its pressure on one sequential colormap and as wide as its flow, tanks filling and emptying,
 * valves open or shut, the bottle draining. Hover anything for its numbers.
 *
 * The drawing's structure (symbols, routes, labels) is laid out once per size; only the live layers
 * read the cursor, and they re-render only when it moves to another sample.
 */

const LABEL_FONT = `11px ${SANS}`;
const VALUE_FONT = `12px ${MONO}`;
const ROW = 14;

type Hover = { kind: 'line' | 'symbol'; id: string; x: number; y: number } | null;

const VESSELS = new Set(['tank', 'dewar', 'bottle', 'engine']);
const ALWAYS = new Set(['tank', 'dewar', 'bottle', 'engine', 'regulator']);
const VALVES = new Set(['solenoid', 'valve', 'check', 'relief', 'qd']);
/** Below this many px per drawing unit only the vessels, the regulators and the main valves are named. */
const NAME_ALL_AT = 0.9;

/** Rows a symbol's label takes: its name, and under a vessel its figure. */
const labelRows = (s: DSymbol, view: NetView | null) =>
  VESSELS.has(s.kind) || (s.kind === 'regulator' && !!view?.symbols.get(s.id)?.use) ? 2 : 1;

export function Schematic({ result, drawingId, doc, maxHeight = 340 }: {
  result: LayerXResult;
  drawingId: string;
  /** The drawing document, when the caller has it (tests, the harness); otherwise it is fetched. */
  doc?: DrawingDocument | null;
  /** The tallest it is drawn [px] on a narrow panel; a wide one may take 0.42 of its width. */
  maxHeight?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref, doc ? 880 : 0);
  const theme = useLxTheme(ref);
  const loaded = useDrawingDocument(drawingId, doc);
  const drawing = useMemo(() => (loaded.state === 'ready' ? parseDrawing(loaded.value.document) : null), [loaded]);
  const view = useMemo(() => (drawing ? buildNetView(drawing, result) : null), [drawing, result]);
  const mains = useMemo(() => {
    if (!drawing) return new Set<string>();
    const out = new Set<string>();
    for (const [id] of tankSides(drawing, result)) {
      const tank = drawing.byId.get(id);
      const path = tank ? liquidPath(drawing, tank) : null;
      for (const v of path?.via ?? []) if (INLINE.has(v.kind)) out.add(v.id);
    }
    return out;
  }, [drawing, result]);
  // A wide panel may grow taller too, so the drawing uses its width (and names every valve).
  const capH = Math.max(maxHeight, Math.round(width * 0.42));
  const roomy = drawing && width > 0 ? fitScale(drawing, width, capH) >= NAME_ALL_AT : false;
  const labelSize = useCallback((s: DSymbol) => {
    if (!ALWAYS.has(s.kind) && !(VALVES.has(s.kind) && (roomy || mains.has(s.id)))) return null;
    const rows = labelRows(s, view);
    const name = textWidth(s.label, LABEL_FONT);
    const value = rows > 1 ? textWidth('0,000', VALUE_FONT) + 4 + textWidth('psia', LABEL_FONT) : 0;
    return { w: Math.ceil(Math.max(name, value)) + 2, h: rows * ROW };
  }, [view, roomy, mains]);
  const layout = useMemo(
    () => (drawing && width > 0 ? layoutSchematic(drawing, { width, maxHeight: capH, minHeight: 200, labelSize }) : null),
    [drawing, width, capH, labelSize],
  );
  const scale = useMemo(() => (view?.pRange ? pressureScale(view.pRange[0], view.pRange[1]) : null), [view]);
  const [hover, setHover] = useState<Hover>(null);
  const cardId = `${useId()}-card`;

  if (loaded.state === 'error') {
    return <div ref={ref}><NotComputed height={240}><span title={loaded.error}>The drawing is not available</span></NotComputed></div>;
  }
  return (
    <div ref={ref} className="relative min-w-0" onPointerLeave={() => setHover(null)}>
      {!layout || !view || !drawing
        ? <NotComputed height={260}>Loading the drawing</NotComputed>
        : (
          <>
            <svg width={layout.width} height={layout.height} role="group" aria-label="Feed system schematic" className="block select-none"
                 style={{ fontFamily: SANS }}>
              <Leaders layout={layout} />
              <LiveLines layout={layout} view={view} scale={scale} theme={theme} hover={hover} />
              <Statics layout={layout} />
              <LiveOverlays layout={layout} view={view} />
              <Tags layout={layout} />
              <Labels layout={layout} />
              <LiveFigures layout={layout} view={view} />
              <Hits layout={layout} drawing={drawing} onHover={setHover} described={hover?.kind === 'symbol' ? hover.id : null} cardId={cardId} />
              <FocusRing layout={layout} drawing={drawing} result={result} />
            </svg>
            <Legend scale={scale} theme={theme} mdotMax={view.mdotMax} source={view.source} />
            {hover && <Card id={cardId} hover={hover} drawing={drawing} view={view} bounds={{ w: layout.width, h: layout.height + 40 }} />}
          </>
        )}
    </div>
  );
}

// ------------------------------------------------------------------ static layers

const Leaders = memo(function Leaders({ layout }: { layout: SchematicLayout }) {
  return (
    <g aria-hidden stroke={INK_QUIET} strokeWidth={1} strokeDasharray="2 2" fill="none">
      {layout.tags.map((t) => {
        const h = layout.symbols.get(t.host);
        return h ? <path key={t.s.id} d={`M${h.cx} ${h.cy} L${t.cx} ${t.cy}`} /> : null;
      })}
    </g>
  );
});

/** Which way a vent's only line arrives, so its arrowhead points out. */
function ventDirs(layout: SchematicLayout): Map<string, Dir> {
  const m = new Map<string, Dir>();
  for (const l of layout.lines) {
    for (const [id, a, b] of [[l.line.to, l.pts[l.pts.length - 2], l.pts[l.pts.length - 1]], [l.line.from, l.pts[1], l.pts[0]]] as const) {
      const s = layout.symbols.get(id);
      if (s?.s.kind !== 'vent' || !a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      m.set(id, Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : dy >= 0 ? 'down' : 'up');
    }
  }
  return m;
}

const Statics = memo(function Statics({ layout }: { layout: SchematicLayout }) {
  const vents = useMemo(() => ventDirs(layout), [layout]);
  return (
    <g aria-hidden>
      {[...layout.symbols.values()].map((p) => <SymbolShape key={p.s.id} p={p} ventDir={vents.get(p.s.id)} />)}
    </g>
  );
});

const Tags = memo(function Tags({ layout }: { layout: SchematicLayout }) {
  return (
    <g aria-hidden>
      {layout.tags.map((t) => (
        <g key={t.s.id} transform={`translate(${t.cx} ${t.cy})`}>
          <circle r={t.r} fill={PAPER} stroke={INK_QUIET} strokeWidth={1} />
          <text textAnchor="middle" dominantBaseline="central" fontSize={8.5} fontWeight={500} fill={INK} style={{ letterSpacing: '0.02em' }}>
            {t.s.type}
          </text>
        </g>
      ))}
    </g>
  );
});

/** A surface-coloured outline under text, so a line passing behind a label never runs through it. */
const HALO = { stroke: PAPER, strokeWidth: 3, strokeLinejoin: 'round' as const, paintOrder: 'stroke' as const };

const Labels = memo(function Labels({ layout }: { layout: SchematicLayout }) {
  return (
    <g aria-hidden fontSize={11} fill={INK_QUIET} {...HALO}>
      {[...layout.labels.values()].map((l) => {
        const s = layout.symbols.get(l.id);
        return s ? <text key={l.id} x={l.x} y={l.y + 10} textAnchor={l.anchor}>{s.s.label}</text> : null;
      })}
    </g>
  );
});

// ------------------------------------------------------------------ live layers

const LiveLines = memo(function LiveLines({ layout, view, scale, theme, hover }: {
  layout: SchematicLayout; view: NetView; scale: PressureScale | null; theme: ThemeName; hover: Hover;
}) {
  const i = useCursorIndexOr(Math.floor(view.t.length / 2));
  return (
    <g fill="none" strokeLinejoin="round">
      {layout.lines.map((pl) => {
        const r = view.lines.get(pl.line.id);
        const p = at(r?.p, i);
        const color = p !== null && scale ? seqColor(scale.norm(p), theme) : null;
        const m = at(r?.mdot, i);
        const w = m !== null ? flowWidth(m, view.mdotMax) : color ? 1.5 : 1;
        const d = pathOf(pl.pts);
        const hot = hover?.kind === 'line' && hover.id === pl.line.id;
        return (
          <g key={pl.line.id}>
            {hot && <path d={d} stroke="var(--lx-text)" strokeOpacity={0.22} strokeWidth={w + 6} />}
            <path d={d} stroke={color ?? INK_QUIET} strokeOpacity={color ? 1 : 0.6} strokeWidth={w} data-line={pl.line.id} />
          </g>
        );
      })}
    </g>
  );
});

/** How full a vessel is drawn: liquid level for a tank, pressure against its start for the bottle. */
function LiveOverlays({ layout, view }: { layout: SchematicLayout; view: NetView }) {
  const i = useCursorIndexOr(Math.floor(view.t.length / 2));
  const sides = useMemo(() => tankSidesOf(view), [view]);
  return (
    <g>
      {[...layout.symbols.values()].map((p) => {
        const r = view.symbols.get(p.s.id);
        if (!r) return null;
        if (p.s.kind === 'tank' || p.s.kind === 'dewar') return <TankFill key={p.s.id} p={p} level={at(r.level, i)} gasT={at(r.T, i)} range={view.ullageRange} side={sides.get(p.s.id) ?? null} />;
        if (p.s.kind === 'bottle') {
          const p0 = r.p?.find((x) => x !== null && Number.isFinite(x)) ?? null;
          const now = at(r.p, i);
          return <BottleFill key={p.s.id} p={p} frac={p0 && now !== null ? now / p0 : null} />;
        }
        if (SWITCHED.has(p.s.kind) || p.s.kind === 'regulator') return <ValveState key={p.s.id} p={p} state={at(r.state, i)} known={!!r.state} />;
        if (p.s.kind === 'engine') return <EngineLit key={p.s.id} p={p} lit={(at(r.p, i) ?? 0) > 0} />;
        return null;
      })}
    </g>
  );
}

const tankSidesOf = (view: NetView) => {
  const m = new Map<string, 'ox' | 'fuel'>();
  for (const [id, r] of view.symbols) if (r.side === 'ox' || r.side === 'fuel') m.set(id, r.side);
  return m;
};

function TankFill({ p, level, gasT, range, side }: { p: PlacedSymbol; level: number | null; gasT: number | null; range: [number, number] | null; side: 'ox' | 'fuel' | null }) {
  const clip = `lx-hero-clip-${p.s.id}`;
  const shape = tankShape(p.w, p.h);
  const lv = level === null ? null : Math.min(1, Math.max(0, level));
  const yLevel = lv === null ? null : p.h / 2 - lv * p.h;
  const color = side === 'ox' ? 'var(--lx-lox)' : 'var(--lx-fuel)';
  // Ullage tint: the run's coolest tank gas 2 % heat colour, its warmest 10 %.
  const warm = gasT !== null && range && range[1] > range[0] ? (gasT - range[0]) / (range[1] - range[0]) : null;
  return (
    <g transform={`translate(${p.cx} ${p.cy})`} aria-hidden>
      <clipPath id={clip}><rect {...shape} /></clipPath>
      <g clipPath={`url(#${clip})`}>
        {warm !== null && <rect x={-p.w / 2} y={-p.h / 2} width={p.w} height={yLevel === null ? p.h : yLevel + p.h / 2}
                                 style={{ fill: `color-mix(in srgb, var(--lx-hot) ${Math.round(2 + 8 * warm)}%, transparent)` }} />}
        {yLevel !== null && side && (
          <>
            <rect x={-p.w / 2} y={yLevel} width={p.w} height={p.h / 2 - yLevel} style={{ fill: `color-mix(in srgb, ${color} 30%, transparent)` }} />
            <path d={`M${-p.w / 2} ${yLevel} H${p.w / 2}`} stroke={color} strokeWidth={1.5} />
          </>
        )}
      </g>
      <rect {...shape} fill="none" stroke={INK} strokeWidth={1.5} />
    </g>
  );
}

function BottleFill({ p, frac }: { p: PlacedSymbol; frac: number | null }) {
  if (frac === null) return null;
  const clip = `lx-hero-clip-${p.s.id}`;
  const shape = bottleShape(p.w, p.h);
  const f = Math.min(1, Math.max(0, frac));
  return (
    <g transform={`translate(${p.cx} ${p.cy})`} aria-hidden>
      <clipPath id={clip}><rect {...shape} /></clipPath>
      <rect clipPath={`url(#${clip})`} x={-p.w / 2} y={p.h / 2 - f * p.h} width={p.w} height={f * p.h}
            style={{ fill: 'color-mix(in srgb, var(--lx-gas) 28%, transparent)' }} />
      <rect {...shape} fill="none" stroke={INK} strokeWidth={1.5} />
    </g>
  );
}

function ValveState({ p, state, known }: { p: PlacedSymbol; state: number | null; known: boolean }) {
  // Shut is filled (the P&ID convention); open is hollow; a valve the run says nothing about is
  // drawn in the quiet ink.
  const shut = state !== null && state <= 0.01;
  const body = p.s.kind === 'regulator' ? bowtie(REG_W, REG_H) : bowtie(VALVE_W, VALVE_H);
  const ink = known && state !== null ? INK : INK_QUIET;
  return (
    <path transform={`translate(${p.cx} ${p.cy})${p.axis === 'v' ? ' rotate(90)' : ''}`} d={body} aria-hidden
          fill={shut ? INK : PAPER} stroke={ink} strokeWidth={1.5} strokeLinejoin="round" />
  );
}

/** Firing: the chamber outlined in the heat colour. */
function EngineLit({ p, lit }: { p: PlacedSymbol; lit: boolean }) {
  if (!lit) return null;
  return <path transform={`translate(${p.cx} ${p.cy})`} d={CHAMBER_PATH} aria-hidden stroke="var(--lx-hot)" strokeWidth={1.5} fill="none" strokeLinejoin="round" />;
}

function LiveFigures({ layout, view }: { layout: SchematicLayout; view: NetView }) {
  const i = useCursorIndexOr(Math.floor(view.t.length / 2));
  const u = useUnits();
  return (
    <g aria-hidden>
      {[...layout.labels.values()].map((l) => {
        const s = layout.symbols.get(l.id)?.s;
        const f = s ? vesselFigure(s, view.symbols.get(s.id), i, u) : null;
        if (!f) return null;
        return (
          <text key={l.id} x={l.x} y={l.y + 10 + ROW} textAnchor={l.anchor} {...HALO}>
            <tspan fontFamily={MONO} fontSize={12} fill="var(--lx-text)" style={{ fontVariantNumeric: 'tabular-nums' }}>{f.num}</tspan>
            {f.unit && <tspan dx={3} fontSize={11} fill={INK_QUIET}>{f.unit}</tspan>}
          </text>
        );
      })}
    </g>
  );
}

// ------------------------------------------------------------------ hover

const Hits = memo(function Hits({ layout, drawing, onHover, described, cardId }: {
  layout: SchematicLayout; drawing: Drawing; onHover: (h: Hover) => void; described: string | null; cardId: string;
}) {
  const at = (e: ReactPointerEvent<SVGElement>) => {
    const box = (e.currentTarget.ownerSVGElement ?? (e.currentTarget as unknown as SVGSVGElement)).getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };
  return (
    <g>
      {layout.lines.map((pl) => (
        <path key={pl.line.id} d={pathOf(pl.pts)} fill="none" stroke="transparent" strokeWidth={12} style={{ pointerEvents: 'stroke' }}
              onPointerEnter={(e) => onHover({ kind: 'line', id: pl.line.id, ...at(e) })}
              aria-hidden data-name={lineName(drawing, pl.line)} />
      ))}
      {[...layout.symbols.values(), ...layout.tags.map((t) => ({ s: t.s, cx: t.cx, cy: t.cy, w: t.r * 2, h: t.r * 2 }))].map((p) => (
        <rect key={p.s.id} className="lx-hero-hit" x={p.cx - p.w / 2 - 3} y={p.cy - p.h / 2 - 3} width={p.w + 6} height={p.h + 6} fill="transparent"
              tabIndex={0} role="img" aria-label={p.s.label} aria-describedby={described === p.s.id ? cardId : undefined}
              onPointerEnter={(e) => onHover({ kind: 'symbol', id: p.s.id, ...at(e) })}
              onFocus={() => onHover({ kind: 'symbol', id: p.s.id, x: p.cx + p.w / 2, y: p.cy })}
              onBlur={() => onHover(null)} />
      ))}
    </g>
  );
});

const KIND_WORD: Partial<Record<DSymbol['kind'], string>> = {
  bottle: 'Pressurant bottle', tank: 'Tank', dewar: 'Dewar', regulator: 'Regulator', solenoid: 'Solenoid valve',
  valve: 'Ball valve', check: 'Check valve', relief: 'Relief valve', qd: 'Quick disconnect', manifold: 'Manifold',
  junction: 'Tee', vent: 'Vent', engine: 'Injector and chamber', instrument: 'Instrument',
};

function Card({ id, hover, drawing, view, bounds }: { id: string; hover: NonNullable<Hover>; drawing: Drawing; view: NetView; bounds: { w: number; h: number } }) {
  const i = useCursorIndexOr(Math.floor(view.t.length / 2));
  const u = useUnits();
  const t = view.t[i];
  if (hover.kind === 'line') {
    const l = drawing.lines.find((x) => x.id === hover.id);
    if (!l) return null;
    const bore = l.params.bore;
    const len = l.params.length;
    const sub = [bore ? `${numText({ value: bore.value, digits: 2 })}\u00a0${bore.unit} bore` : null,
      len ? `${numText({ value: len.value, digits: 2 })}\u00a0${len.unit}` : null].filter(Boolean).join(' · ');
    return <HoverCard id={id} x={hover.x} y={hover.y} bounds={bounds} title={lineName(drawing, l)} sub={sub || undefined}
                      time={formatT(t)} rows={lineRows(view.lines.get(l.id), i, u)} />;
  }
  const s = drawing.byId.get(hover.id);
  if (!s) return null;
  return <HoverCard id={id} x={hover.x} y={hover.y} bounds={bounds} title={s.label} sub={subFor(s, u)}
                    time={formatT(t)} rows={symbolRows(s, view.symbols.get(s.id), i, u)} />;
}

function subFor(s: DSymbol, u: Units): string | undefined {
  const word = KIND_WORD[s.kind];
  const v = s.params.volume;
  const vol = v && (s.kind === 'tank' || s.kind === 'bottle' || s.kind === 'dewar') ? `${numText({ value: v.value, digits: 2 })}\u00a0${v.unit}` : null;
  const set = s.params.setpoint && s.kind === 'regulator' ? `set ${u.fmt({ value: s.params.setpoint.value, digits: 0, unit: s.params.setpoint.unit })}` : null;
  const parts = [s.kind === 'instrument' ? s.type : word, vol, set, INLINE.has(s.kind) && s.fluid ? s.fluid : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

// ------------------------------------------------------------------ the margin bar's jump

const selFocus = (s: TimeState) => s.focus;

/** A margin bar clicked with a key the schematic has a place for: ring that place briefly. */
function FocusRing({ layout, drawing, result }: { layout: SchematicLayout; drawing: Drawing; result: LayerXResult }) {
  const store = useOptionalTimeStore();
  const focus = useTimeOf(store, selFocus, Object.is, null);
  const target = useMemo(() => {
    const sides = tankSides(drawing, result);
    const tank = (side: 'ox' | 'fuel') => [...sides].find(([, s]) => s === side)?.[0];
    const engine = drawing.symbols.find((s) => s.kind === 'engine')?.id;
    return (key: string): string | undefined => {
      if (key === 'lox_tank') return tank('ox');
      if (key === 'fuel_tank') return tank('fuel');
      if (key === 'bottle') return bottleOf(drawing, result)?.id;
      if (key === 'chug' || key === 'pc' || key.startsWith('stiff')) return engine;
      if (key.startsWith('sat-')) return key.slice(4).split('.')[0];
      // A drawing symbol named outright (a water-hammer limit names its main valve).
      if (key.startsWith('node:')) return key.slice(5);
      return undefined;
    };
  }, [drawing, result]);
  if (!focus) return null;
  const id = target(focus.key);
  const p = id ? layout.symbols.get(id) : undefined;
  if (!p) return null;
  return (
    <rect key={focus.seq} className="lx-hero-focus" x={p.cx - p.w / 2 - 6} y={p.cy - p.h / 2 - 6} width={p.w + 12} height={p.h + 12} rx={6}
          fill="none" stroke="var(--lx-accent)" strokeWidth={2} aria-hidden />
  );
}

// ------------------------------------------------------------------ legend

const TICK_FONT = `11px ${MONO}`;
const BAR = 168;

function Legend({ scale, theme, mdotMax, source }: { scale: PressureScale | null; theme: ThemeName; mdotMax: number; source: NetView['source'] }) {
  const u = useUnits();
  const ps = u.scale('pressure');
  const label = useCallback((v: number) => numText({ value: v, digits: ps.digits }), [ps]);
  const ticks = useMemo(
    () => (scale ? colorbarTicks(scale, ps.to, ps.from, { barPx: BAR, widthOf: (v) => textWidth(label(v), TICK_FONT), gapPx: 8 }) : []),
    [scale, ps, label],
  );
  const grad = useMemo(() => Array.from({ length: 11 }, (_, k) => `${seqColor(k / 10, theme)} ${k * 10}%`).join(', '), [theme]);
  return (
    <div className="mt-1 flex flex-wrap items-start gap-x-8 gap-y-2 text-[11px] text-[var(--lx-text-3)]">
      {scale && (
        <div className="flex items-start gap-2" aria-label="Line colour: pressure">
          <span className="leading-[10px]">Pressure</span>
          <div style={{ width: BAR }}>
            <div className="h-[6px] rounded-[2px]" style={{ background: `linear-gradient(to right, ${grad})` }} />
            <div className="relative h-[14px]">
              {ticks.map((t, k) => (
                <span key={k} className="lx-num absolute top-[2px] whitespace-nowrap"
                      style={{ left: `${t.u * 100}%`, transform: k === 0 ? 'none' : k === ticks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}>
                  {label(t.value)}
                </span>
              ))}
            </div>
          </div>
          <span className="leading-[10px]">{ps.unit}</span>
        </div>
      )}
      {mdotMax > 0 && (
        <div className="flex items-start gap-2" aria-label="Line width: mass flow">
          <span className="leading-[10px]">Flow</span>
          <div>
            <svg width={64} height={6} aria-hidden className="block"><path d="M0 2.5 L64 0.5 L64 5.5 L0 3.5 Z" fill={INK_QUIET} /></svg>
            <span className="lx-num mt-[2px] block whitespace-nowrap">0 – {u.fmt(u.mdot(mdotMax))}</span>
          </div>
        </div>
      )}
      {source === 'series' && (
        <span className="ml-auto self-center" title="This run did not record the feed network: lines are read from the bottle, regulator and tank series by where they sit, and grey lines have no reading.">
          network not recorded
        </span>
      )}
    </div>
  );
}
