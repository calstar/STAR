import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { getChamberGeometry, type ChamberGeometryResponse } from '../../../api/client';
import type { LayerXResult } from '../../../api/layerx';
import { plume, type NozzleState } from '../../layerx/plume';
import { MONO, SANS } from '../charts/measure';
import { formatT } from '../time/markers';
import { nearestIndex } from '../time/search';
import { Figure, NotComputed } from '../ui';
import { MINUS, NBSP, numText, useUnits, type Quantity } from '../units';
import { HoverCard } from './Card';
import { heroBlocks } from './contract';
import {
  chamberRecessionAt, geometryIsRuns, runThroatMm, sectionFromContour, sectionFromGeometry, throatAreaRatioAt,
  framesAgree, wallFromFrames, wallFromGrowth, type Section,
} from './contour';
import { useCursorIndexOr, useWidth } from './hooks';
import { plumeArt, plumeLengthDe, separationAreaRatio, stationAtRadius } from './plumeGeom';
import { colormapCss } from '../charts/colormap';
import { stateAlong } from './thermo';
import type { Row } from './readout';

/**
 * The engine in section, to scale, at the cursor (GUI-SPEC "Hero"): the as-built gas-side outline
 * faint, the wall as it stands now solid, the liner behind it, the throat's diameter on the
 * drawing, and the plume leaving the exit -- understated, from the exit and ambient pressures.
 */

type GeoState = { state: 'idle' | 'loading' } | { state: 'ready'; g: ChamberGeometryResponse | null; error?: string };

/** The open design's geometry, unless the run carries its own contour or the caller passed one. */
function useGeometry(skip: boolean, preset: ChamberGeometryResponse | null | undefined): GeoState {
  const [got, setGot] = useState<GeoState>({ state: 'idle' });
  useEffect(() => {
    if (skip || preset !== undefined) return;
    let live = true;
    (async () => {
      for (let k = 0; k < 3 && live; k++) {
        const r = await getChamberGeometry();
        if (r.data) { if (live) setGot({ state: 'ready', g: r.data }); return; }
        await new Promise((res) => setTimeout(res, 1200 * (k + 1)));
      }
      if (live) setGot({ state: 'ready', g: null, error: 'The design geometry did not load' });
    })();
    return () => { live = false; };
  }, [skip, preset]);
  if (preset !== undefined) return { state: 'ready', g: preset };
  return skip ? { state: 'ready', g: null } : got.state === 'idle' ? { state: 'loading' } : got;
}

const PAD = { l: 8, r: 8, t: 30, b: 24 };
const MAX_H = 220;

export function EngineSection({ result, geometry, maxHeight = MAX_H, vertical = false, height = 600 }: {
  result: LayerXResult; geometry?: ChamberGeometryResponse | null;
  /** The drawing's tallest [px]: the hero's column is narrow, a page of its own can be roomier. */
  maxHeight?: number;
  /** Drawn pointing down, injector at the top, beside the feed system that feeds it, with the gas's
   *  state along it; `height` is then the drawing's length [px]. */
  vertical?: boolean;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref, geometry !== undefined ? 380 : 0);
  const u = useUnits();
  const blocks = useMemo(() => heroBlocks(result), [result]);
  const own = useMemo(() => (blocks.hardware?.contour ? sectionFromContour(blocks.hardware.contour) : null), [blocks]);
  const geo = useGeometry(!!own, geometry);
  const { section, why } = useMemo((): { section: Section | null; why: string | null } => {
    if (own) return { section: own, why: null };
    if (geo.state !== 'ready') return { section: null, why: null };
    if (!geo.g) return { section: null, why: 'error' in geo && geo.error ? geo.error : 'No design geometry' };
    if (!geometryIsRuns(geo.g, result)) {
      const d = runThroatMm(result);
      return {
        section: null,
        why: `The open design's throat is ${numText({ value: geo.g.D_throat * 1000, digits: 2 })}${NBSP}mm; this run's engine has ${d !== null ? `${numText({ value: d, digits: 2 })}${NBSP}mm` : 'another'}. Open the run's design to draw it.`,
      };
    }
    return { section: sectionFromGeometry(geo.g), why: null };
  }, [own, geo, result]);

  return (
    <div ref={ref} className="relative min-w-0">
      {!section
        ? (
          <NotComputed height={200}>
            {why ? <span title={why}>Contour not computed for this run</span> : 'Loading the contour'}
          </NotComputed>
        )
        : width > 0 && (vertical
          ? <Drawn section={section} result={result} width={height} maxHeight={Math.max(60, width - LABEL_W)} blocks={blocks} u={u} vertical />
          : <Drawn section={section} result={result} width={width} maxHeight={maxHeight} blocks={blocks} u={u} />)}
    </div>
  );
}

interface Moment {
  t: number;
  wall: number[];
  areaRatio: number;
  nozzle: NozzleState | null;
  /** The chamber's gamma at the cursor, when the run carries it. */
  gammaC: number | null;
  /** What the engine delivers at the cursor, when firing. */
  perf: { thrust?: number; isp?: number; of?: number; mdot?: number; cstar?: number } | null;
}

/** Room right of a vertical engine for its stations' figures [px]. */
const LABEL_W = 150;

function useMoment(section: Section, result: LayerXResult, blocks: ReturnType<typeof heroBlocks>): Moment {
  const i = useCursorIndexOr(Math.floor(result.series.t.length / 2));
  const t = result.series.t[Math.max(0, i)] ?? 0;
  return useMemo(() => {
    const hw = blocks.hardware;
    const raw = hw?.contour ? wallFromFrames(hw.contour, section.x.length, t) : null;
    const areaRatio = throatAreaRatioAt(result, t, hw);
    // Runs saved before 2026-10-03 drew the insert's downstream half as built, so their frames keep
    // the as-built throat while the run's own throat area grows: trust the frames only when their
    // narrowest point is the run's throat.
    const frames = raw && framesAgree(raw, section, areaRatio) ? raw : null;
    const wall = frames ?? wallFromGrowth(section, areaRatio, chamberRecessionAt(result, t));
    const dv = result.delivered;
    let nozzle: NozzleState | null = null;
    let gammaC: number | null = null;
    let perf: Moment['perf'] = null;
    if (dv?.t?.length && dv.p_exit_psia && dv.ambient_psia && dv.gamma_exit) {
      const k = nearestIndex(dv.t, t);
      const step = dv.t.length > 1 ? Math.abs(dv.t[1] - dv.t[0]) : 0.05;
      if (k >= 0 && Math.abs(dv.t[k] - t) <= step * 0.51) {
        nozzle = { pc_psia: dv.pc_psia[k], pe_psia: dv.p_exit_psia[k], pa_psia: dv.ambient_psia[k], gamma: dv.gamma_exit[k], tc_K: dv.tc_K?.[k], te_K: dv.t_exit_K?.[k] };
        const d = dv as unknown as Record<string, readonly number[] | undefined>;
        gammaC = d.gamma?.[k] ?? null;
        const mo = d.mdot_O?.[k];
        const mf = d.mdot_F?.[k];
        perf = { thrust: d.thrust_N?.[k], isp: d.isp_s?.[k], of: d.mr?.[k], cstar: d.cstar?.[k],
                 mdot: mo !== undefined && mf !== undefined ? mo + mf : undefined };
      }
    }
    return { t, wall, areaRatio, nozzle, gammaC, perf };
  }, [section, result, blocks, t]);
}

function Drawn({ section, result, width, maxHeight, blocks, u, vertical = false }: {
  section: Section; result: LayerXResult; width: number; maxHeight: number; blocks: ReturnType<typeof heroBlocks>; u: ReturnType<typeof useUnits>;
  /** Laid out along `width` as usual, then turned so the flow runs down the page. */
  vertical?: boolean;
}) {
  const m = useMoment(section, result, blocks);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  // On its end the engine has length to spare: two median shock cells of plume, so the diamonds
  // show through the burn (one cell's worth lost them whenever the cursor's cell ran long).
  const plumeDe = useMemo(() => {
    const states = nozzleStates(result);
    if (!vertical) return plumeLengthDe(states);
    // Two of the burn's longest cells: the cells stretch as the chamber pressure falls, and a
    // plume sized on the median lost its second diamond for the last second of the burn.
    const longest = Math.max(0, ...states.map((st) => plume(st)?.cellOverDe ?? 0).filter((c) => Number.isFinite(c)));
    return Math.max(plumeLengthDe(states), longest * 2.3);
  }, [result, vertical]);
  const s = section;
  const n = s.x.length;
  const x0 = s.x[0];
  const xe = s.x[n - 1];
  const reNow = m.wall[n - 1];
  const re0 = s.r0[n - 1];
  const De = 2 * re0;
  const outer = Math.max(s.caseR ?? 0, ...(s.liner ?? s.r0));
  const plumeR = re0 * 1.35;
  const spanMm = xe - x0 + plumeDe * De;
  const halfMm = Math.max(outer, plumeR);
  const k = Math.min((width - PAD.l - PAD.r) / spanMm, (maxHeight - PAD.t - PAD.b) / (2 * halfMm));
  const H = Math.round(2 * halfMm * k + PAD.t + PAD.b);
  const cy = PAD.t + halfMm * k;
  const sx = (x: number) => PAD.l + (x - x0) * k;
  const up = (r: number) => cy - r * k;
  const dn = (r: number) => cy + r * k;

  const profile = (r: readonly number[], f: (v: number) => number) => s.x.map((x, i) => `${i ? 'L' : 'M'}${sx(x).toFixed(1)} ${f(r[i]).toFixed(1)}`).join(' ');
  const band = (inner: readonly number[], outerR: readonly number[], f: (v: number) => number) => {
    const a = s.x.map((x, i) => `${i ? 'L' : 'M'}${sx(x).toFixed(1)} ${f(outerR[i]).toFixed(1)}`).join(' ');
    const b = [...s.x].reverse().map((x, j) => `L${sx(x).toFixed(1)} ${f(inner[n - 1 - j]).toFixed(1)}`).join(' ');
    return `${a} ${b} Z`;
  };

  // Throat: where the wall is narrowest now.
  const it = m.wall.reduce((best, r, i) => (r < m.wall[best] ? i : best), 0);
  const xt = sx(s.x[it]);
  const dNow = 2 * m.wall[it];
  const d0 = 2 * s.r0[s.throat];
  const growth = d0 > 0 ? dNow / d0 - 1 : 0;

  const art = useMemo(() => (m.nozzle ? plumeArt(m.nozzle, plumeDe) : null), [m.nozzle, plumeDe]);
  // The gas inside the walls, coloured by its static temperature (isentropic, see thermo.ts).
  const gas = useMemo(() => {
    const nz = m.nozzle;
    if (!nz?.tc_K || !m.gammaC || !nz.gamma) return null;
    return stateAlong(m.wall, it, nz.tc_K, nz.pc_psia, m.gammaC, nz.gamma);
  }, [m.wall, it, m.nozzle, m.gammaC]);
  const gasFill = useMemo(() => {
    if (!gas) return null;
    const hi = gas.T[0];
    const lo = Math.min(...gas.T);
    const f = (T: number) => (hi > lo ? (T - lo) / (hi - lo) : 1);
    return s.x.slice(0, -1).map((x, i) => ({
      d: `M${sx(x).toFixed(1)} ${up(m.wall[i]).toFixed(1)} L${sx(s.x[i + 1]).toFixed(1)} ${up(m.wall[i + 1]).toFixed(1)} ` +
         `L${sx(s.x[i + 1]).toFixed(1)} ${dn(m.wall[i + 1]).toFixed(1)} L${sx(x).toFixed(1)} ${dn(m.wall[i]).toFixed(1)} Z`,
      fill: colormapCss('magma', 0.3 + 0.67 * f(0.5 * (gas.T[i] + gas.T[i + 1]))),
    }));
    // sx/up/dn are this render's scale, which only changes with what is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gas, s, m.wall, k, cy]);
  const sepIdx = useMemo(() => {
    const flagged = blocks.hardware?.separation?.flag === true;
    if (!m.nozzle || !(flagged || art?.p.regime === 'separated')) return null;
    const ar = separationAreaRatio(m.nozzle);
    const at = ar ? stationAtRadius(s.r0, s.throat, s.r0[s.throat] * Math.sqrt(ar)) : null;
    // The run says it separates but the exit pressure does not place it: mark the exit.
    return at ?? (flagged ? n - 1 : null);
  }, [m.nozzle, art, blocks, s, n]);

  // Plume coordinates: x in exit diameters from the exit, r in exit radii.
  const px = (xDe: number) => sx(xe) + xDe * De * k;
  const pr = (rRe: number) => rRe * reNow * k;
  // The jet's two edges, open downstream: it does not end, it fades out of the frame.
  const plumeD = art
    ? `${art.edge.map((e, j) => `${j ? 'L' : 'M'}${px(e.x).toFixed(1)} ${(cy - pr(e.r)).toFixed(1)}`).join(' ')} ` +
      `${art.edge.map((e, j) => `${j ? 'L' : 'M'}${px(e.x).toFixed(1)} ${(cy + pr(e.r)).toFixed(1)}`).join(' ')}`
    : null;

  // The region between the jet's two edges, for its glow.
  const plumeFill = art
    ? `${art.edge.map((e, j) => `${j ? 'L' : 'M'}${px(e.x).toFixed(1)} ${(cy - pr(e.r)).toFixed(1)}`).join(' ')} ` +
      `${[...art.edge].reverse().map((e) => `L${px(e.x).toFixed(1)} ${(cy + pr(e.r)).toFixed(1)}`).join(' ')} Z`
    : null;
  const glowId = `${useId()}-glow`;

  const liner = s.liner;
  const linerLeft = liner ? liner[it] - m.wall[it] : null;
  // At the throat the lining is the graphite insert when the engine has one.
  const linerWord = s.insert && s.x[it] >= s.insert[0] && s.x[it] <= s.insert[1] ? 'Insert at throat' : 'Liner at throat';
  const rows: Row[] = useMemo(() => {
    const q = (label: string, x: Quantity, note?: string): Row | null => {
      const t = numText(x);
      return t === '—' ? null : { label, num: t, unit: x.unit, note };
    };
    const out = [
      q('Throat', u.len(dNow / 1000), `as built ${u.fmt(u.len(d0 / 1000))}`),
      q('Throat area growth', u.pct(m.areaRatio - 1)),
      linerLeft !== null ? q(linerWord, u.len(linerLeft / 1000)) : null,
      m.nozzle ? q('Chamber', u.p(m.nozzle.pc_psia)) : null,
      m.nozzle ? q('Exit', u.p(m.nozzle.pe_psia)) : null,
      m.nozzle ? q('Air', u.p(m.nozzle.pa_psia)) : null,
      art ? q('Exit / air', u.ratio(art.p.ratio)) : null,
      art ? q('Exit Mach', u.ratio(art.p.machExit)) : null,
      art && art.p.regime !== 'ideal' ? q('Shock cell', u.len((art.p.cellOverDe * De) / 1000)) : null,
    ];
    return out.filter((r): r is Row => r !== null);
  }, [u, dNow, d0, m.areaRatio, linerLeft, linerWord, m.nozzle, art, De]);

  const regimeWord = art ? REGIME[art.p.regime] : null;
  const throatLabel = `Ø${NBSP}${numText(u.len(dNow / 1000))}${NBSP}${u.len(1).unit}`;
  const delta = Math.abs(growth) >= 0.0005 ? `${growth > 0 ? '+' : MINUS}${numText({ value: Math.abs(growth) * 100, digits: 1 })}${NBSP}%` : null;
  const caseTop = up(Math.max(outer, m.wall[it]));

  // Turned: laid out along `width` as usual, then rotated a quarter turn so the flow runs down.
  const svgW = vertical ? H + LABEL_W : width;
  const svgH = vertical ? width : H;
  const turn = vertical ? `translate(${H} 0) rotate(90)` : undefined;
  return (
    <div onPointerLeave={() => setHover(null)} className={vertical ? 'flex items-start gap-6' : undefined}>
      <svg width={svgW} height={svgH} role="img" className="block shrink-0"
           aria-label={`Engine section at ${formatT(m.t)}: throat ${throatLabel}${regimeWord ? `, plume ${regimeWord.toLowerCase()}` : ''}`}
           style={{ fontFamily: SANS }}
           onPointerMove={(e) => {
             const b = e.currentTarget.getBoundingClientRect();
             setHover({ x: e.clientX - b.left, y: e.clientY - b.top });
           }}>
        <g transform={turn}>
        {/* Centreline. */}
        <path d={`M${PAD.l - 4} ${cy} H${Math.min(width - PAD.r, sx(xe) + plumeDe * De * k + 8)}`} stroke="var(--lx-line-strong)" strokeWidth={1} strokeDasharray="6 3 1 3" />
        {/* Case. */}
        {s.caseR && (
          <path d={`M${sx(x0)} ${up(s.caseR)} H${sx(xe)} M${sx(x0)} ${dn(s.caseR)} H${sx(xe)} M${sx(x0)} ${up(s.caseR)} V${dn(s.caseR)}`}
                stroke="var(--lx-text-3)" strokeWidth={1} fill="none" />
        )}
        {/* Liner (between the wall now and its outer face). */}
        {liner && (
          <g style={{ fill: 'color-mix(in srgb, var(--lx-text-3) 22%, transparent)' }}>
            <path d={band(m.wall, liner, up)} />
            <path d={band(m.wall, liner, dn)} />
          </g>
        )}
        {/* Plume. */}
        {art && plumeD && (
          <g>
            {/* The jet itself, a glow that fades downstream inside its boundary. */}
            <defs>
              <linearGradient id={glowId} gradientUnits="userSpaceOnUse" x1={px(0)} y1={cy} x2={px(plumeDe)} y2={cy}>
                <stop offset="0" stopColor="var(--lx-hot)" stopOpacity={0.42} />
                <stop offset="1" stopColor="var(--lx-hot)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <path d={plumeFill ?? ''} fill={`url(#${glowId})`} stroke="none" />
            <path d={plumeD} stroke="var(--lx-hot)" strokeOpacity={0.9} strokeWidth={1.5} fill="none" />
            {art.diamonds.map((d, j) => (
              <path key={j} d={`M${px(d.x - d.hx)} ${cy} L${px(d.x)} ${cy - pr(d.hr)} L${px(d.x + d.hx)} ${cy} L${px(d.x)} ${cy + pr(d.hr)} Z`}
                    stroke="var(--lx-hot)" strokeOpacity={0.85 * art.strength} strokeWidth={1.25}
                    style={{ fill: `color-mix(in srgb, var(--lx-hot) ${Math.round(32 * art.strength)}%, transparent)` }} />
            ))}
            {art.rays.map((r, j) => (
              <path key={j} d={`M${px(0)} ${cy - pr(1)} L${px(r.x)} ${cy - pr(r.r)} M${px(0)} ${cy + pr(1)} L${px(r.x)} ${cy + pr(r.r)}`}
                    stroke="var(--lx-hot)" strokeOpacity={0.7} strokeWidth={1} fill="none" />
            ))}
          </g>
        )}
        {/* The gas, by temperature. */}
        {gasFill && <g opacity={0.6}>{gasFill.map((g, j) => <path key={j} d={g.d} fill={g.fill} stroke={g.fill} strokeWidth={0.8} />)}</g>}
        {/* As built, faint; the wall now, solid. */}
        <g fill="none">
          <path d={profile(s.r0, up)} stroke="var(--lx-text-3)" strokeWidth={1} strokeDasharray="3 2" />
          <path d={profile(s.r0, dn)} stroke="var(--lx-text-3)" strokeWidth={1} strokeDasharray="3 2" />
          {liner && <path d={profile(liner, up)} stroke="var(--lx-text-3)" strokeWidth={1} />}
          {liner && <path d={profile(liner, dn)} stroke="var(--lx-text-3)" strokeWidth={1} />}
          <path d={profile(m.wall, up)} stroke="var(--lx-text)" strokeWidth={1.5} />
          <path d={profile(m.wall, dn)} stroke="var(--lx-text)" strokeWidth={1.5} />
          <path d={`M${sx(x0)} ${up(m.wall[0])} V${dn(m.wall[0])}`} stroke="var(--lx-text)" strokeWidth={1.5} />
        </g>
        {/* Throat dimension. */}
        <g stroke="var(--lx-text-2)" strokeWidth={1} fill="none">
          <path d={`M${xt} ${up(m.wall[it]) + 1.5} V${dn(m.wall[it]) - 1.5} M${xt - 3} ${up(m.wall[it]) + 1.5} H${xt + 3} M${xt - 3} ${dn(m.wall[it]) - 1.5} H${xt + 3}`} />
          {!vertical && <path d={`M${xt} ${caseTop - 2} V${PAD.t - 8}`} strokeDasharray="1 2" />}
        </g>
        {!vertical && (
          <text x={xt} y={PAD.t - 12} textAnchor="middle" fontSize={11} fill="var(--lx-text-3)">
            <tspan fontFamily={MONO} fontSize={12} fill="var(--lx-text)">{throatLabel}</tspan>
            {delta && <tspan dx={4} fontFamily={MONO}>{delta}</tspan>}
          </text>
        )}
        {/* Separation. */}
        {sepIdx !== null && (
          <g>
            <path d={`M${sx(s.x[sepIdx])} ${up(m.wall[sepIdx]) - 5} V${up(m.wall[sepIdx]) + 5} M${sx(s.x[sepIdx])} ${dn(m.wall[sepIdx]) - 5} V${dn(m.wall[sepIdx]) + 5}`}
                  stroke="var(--lx-warn)" strokeWidth={1.5} />
            {!vertical && <text x={sx(s.x[sepIdx])} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--lx-warn)">! separates</text>}
          </g>
        )}
        {/* The plume's regime, under the plume. */}
        {regimeWord && !vertical && (
          <text x={px(plumeDe / 2)} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--lx-text-3)">{regimeWord}</text>
        )}
        </g>
        {vertical && (
          <Stations x={H + 10} rows={[
            { y: sx(x0) + 6, name: 'Chamber', lines: m.nozzle ? [
              `${u.fmt(u.p(m.nozzle.pc_psia))}`,
              m.nozzle.tc_K ? `${u.fmt(u.temp(m.nozzle.tc_K))}` : null] : ['not firing'] },
            { y: xt, name: `Throat ${throatLabel}`, lines: [
              gas ? `${u.fmt(u.p(gas.p[it]))} · M 1` : null,
              gas ? `${u.fmt(u.temp(gas.T[it]))}` : null,
              delta ? `${delta} vs as built` : null] },
            { y: sx(xe) - 4, name: 'Exit', lines: m.nozzle ? [
              `${u.fmt(u.p(m.nozzle.pe_psia))}${art ? ` · M ${numText(u.ratio(art.p.machExit))}` : ''}`,
              m.nozzle.te_K ? `${u.fmt(u.temp(m.nozzle.te_K))}` : null,
              regimeWord] : [] },
            ...(sepIdx !== null ? [{ y: sx(s.x[sepIdx]), name: '! separates', lines: [], warn: true }] : []),
          ]} />
        )}
      </svg>
      {vertical && <Performance perf={m.perf} u={u} />}
      {!vertical && <div className="mt-3 grid gap-x-6 gap-y-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(8.5rem, 1fr))' }}>
        <Figure size="sm" label="Throat" value={numText(u.len(dNow / 1000))} unit={u.len(1).unit}
                delta={delta} deltaTitle="Against the as-built throat" />
        <Figure size="sm" label="Exit / air" value={art ? numText(u.ratio(art.p.ratio)) : '—'}
                sub={m.nozzle ? `${u.fmt(u.p(m.nozzle.pe_psia))} / ${u.fmt(u.p(m.nozzle.pa_psia))}` : 'not firing'} />
        <Figure size="sm" label="Exit Mach" value={art ? numText(u.ratio(art.p.machExit)) : '—'} />
        {linerLeft !== null
          ? <Figure size="sm" label={linerWord} value={numText(u.len(linerLeft / 1000))} unit={u.len(1).unit} />
          : <Figure size="sm" label="Shock cell" {...(art && art.p.regime !== 'ideal'
            ? { value: numText(u.len((art.p.cellOverDe * De) / 1000)), unit: u.len(1).unit } : { value: '—' })} />}
      </div>}
      {hover && (
        <HoverCard x={hover.x} y={hover.y} bounds={{ w: width, h: H + 120 }} title={s.source === 'run' ? 'Engine, as the run eroded it' : 'Engine, the open design'}
                   sub={s.source === 'design' ? 'Contour from the design; wall from the run’s throat growth' : undefined}
                   time={formatT(m.t)} rows={rows} />
      )}
    </div>
  );
}

/** What the engine delivers at the cursor, beside the vertical engine. */
function Performance({ perf, u }: { perf: Moment['perf']; u: ReturnType<typeof useUnits> }) {
  const q = (x: Quantity) => ({ value: numText(x), unit: x.unit });
  if (!perf) return <div className="pt-1 text-[12px] text-[var(--lx-text-3)]">Not firing</div>;
  return (
    <div className="flex min-w-[7.5rem] flex-col gap-4 pt-1">
      <Figure size="sm" label="Thrust" {...q(u.f(perf.thrust))} />
      <Figure size="sm" label="Isp" {...q(u.isp(perf.isp))} />
      <Figure size="sm" label="O/F" {...q(u.of(perf.of))} />
      <Figure size="sm" label="Propellant flow" {...q(u.mdot(perf.mdot))} />
      <Figure size="sm" label="c*" {...q(u.cstar(perf.cstar))} />
    </div>
  );
}

/** A vertical engine's station figures, beside the station they describe. */
function Stations({ x, rows }: { x: number; rows: { y: number; name: string; lines: (string | null)[]; warn?: boolean }[] }) {
  // Each label at its station, or just below the one above it when the stations are close (a
  // short nozzle puts the throat and the exit within a label's height of each other).
  const placed = [...rows].sort((a, b) => a.y - b.y).reduce<{ y: number; name: string; lines: string[]; warn?: boolean; next: number }[]>((out, r) => {
    const lines = r.lines.filter((l): l is string => !!l);
    const y = Math.max(r.y, out.length ? out[out.length - 1].next : -Infinity);
    return [...out, { ...r, y, lines, next: y + 14 * (lines.length + 1) + 4 }];
  }, []);
  return (
    <g fontSize={11}>
      {placed.map((r) => (
        <text key={r.name} x={x} y={r.y} fill={r.warn ? 'var(--lx-warn)' : 'var(--lx-text-3)'}>
          <tspan x={x} dy={0} fill={r.warn ? 'var(--lx-warn)' : 'var(--lx-text-2)'}>{r.name}</tspan>
          {r.lines.map((l) => (
            <tspan key={l} x={x} dy={14} fontFamily={MONO} fill="var(--lx-text)">{l}</tspan>
          ))}
        </text>
      ))}
    </g>
  );
}

/** The nozzle's state at every firing step (delivered), for sizing the plume once per run. */
function nozzleStates(result: LayerXResult): NozzleState[] {
  const dv = result.delivered;
  if (!dv?.t?.length || !dv.p_exit_psia || !dv.ambient_psia || !dv.gamma_exit) return [];
  return dv.t.map((_, k) => ({ pc_psia: dv.pc_psia[k], pe_psia: dv.p_exit_psia![k], pa_psia: dv.ambient_psia![k], gamma: dv.gamma_exit![k] }));
}

const REGIME: Record<string, string> = {
  'under-expanded': 'Under-expanded',
  'over-expanded': 'Over-expanded',
  ideal: 'Ideally expanded',
  separated: 'Separated',
};
