import { useEffect, useMemo, useState } from 'react';
import type { Replay } from '../../../api/layerx';
import { fmt, PSI } from '../../layerx/format';
import { Chart } from '../charts/Chart';
import { alignOnto } from '../charts/resample';
import type { ChartSeries } from '../charts/types';
import { colOf, diag, diagFailed, diagMissing, fetchAxial, type AxialSidecar, type Contour, type HardwareDiag } from '../contract';
import { Badge, Figure, NotComputed, Panel } from '../ui';
import { NBSP, useUnits, type Units } from '../units';
import { convert as conv, type RunData } from '../useRunData';
import { EngineSection } from '../hero/EngineSection';
import { ChartPanel, FigureRow, Hint, NotYet, Table } from './kit';
import type { PageProps } from './Overview';
import { useClockIndex } from './side';

/**
 * Hardware asks "What does the burn do to the engine?": the contour as built, at the cursor and at
 * burnout; the throat, liner, L* and expansion ratio through the burn; heat flux and wall
 * temperature along the engine through the burn (the axial sidecar); whether the nozzle
 * separates; how hot the insert gets after shutdown; and how the erosion was fed back pass by
 * pass.
 */

/** Replay columns the typed API does not name yet (runs after 2026-10-02 carry them). */
type ReplayPlus = Replay & {
  Lstar_m?: (number | null)[];
  eps?: (number | null)[];
  T_liner_surface_K?: (number | null)[] | null;
  heat_flux_chamber_MW_m2?: (number | null)[] | null;
};

const peak = (v: readonly (number | null)[] | null | undefined): number | null => {
  let best: number | null = null;
  for (const x of v ?? []) if (x !== null && Number.isFinite(x) && (best === null || x > best)) best = x;
  return best;
};
const last = (v: readonly (number | null)[] | null | undefined): number | null => {
  const a = v ?? [];
  for (let i = a.length - 1; i >= 0; i--) { const x = a[i]; if (x !== null && Number.isFinite(x)) return x; }
  return null;
};
const isAdiabatic = (s: string | null | undefined) => !!s && /adiabatic/i.test(s);

// ------------------------------------------------------------------ the section

/** How far the wall has moved along the engine: at the cursor and at burnout, in the length unit. */
function RecessionAlong({ contour, u }: { contour: Contour; u: Units }) {
  const frames = contour.frames && contour.frames.t.length ? contour.frames : null;
  const k = useClockIndex(frames?.t);
  const len = u.scale('length');
  const series = useMemo<ChartSeries[] | null>(() => {
    if (!frames) return null;
    const d = (r: readonly number[]) => r.map((rr, j) => len.to((rr - contour.r0_mm[j]) / 1000));
    return [
      { key: 'rec_end', label: 'Burnout', color: '--lx-text-2', dash: [4, 3], values: d(frames.r_mm[frames.r_mm.length - 1]) },
      { key: 'rec_now', label: 'Cursor', color: '--lx-hot', values: d(frames.r_mm[Math.max(0, k)]), width: 2 },
    ];
  }, [frames, k, contour.r0_mm, len]);
  if (!series) return null;
  const xs = contour.x_mm.map((v) => len.to(v / 1000));
  return <Chart t={xs} series={series} yUnit={len.unit} xLabel={len.unit} height={200} store={null} digits={len.digits} title="Wall recession along the engine" />;
}

// ------------------------------------------------------------------ the axial sidecar

type AxialState = { run: string; data?: AxialSidecar; missing?: string };

function useAxial(runId: string | undefined, wanted: boolean): AxialState | null {
  const [state, setState] = useState<AxialState | null>(null);
  useEffect(() => {
    if (!runId || !wanted) return;
    const ctl = new AbortController();
    let tries = 0;
    // The API restarts while the backend is edited: one quiet retry before giving up.
    const go = () => {
      fetchAxial(runId, ctl.signal).then((r) => {
        if (ctl.signal.aborted) return;
        if (r.missing?.includes('did not answer') && tries++ < 1) { window.setTimeout(go, 3000); return; }
        setState({ run: runId, ...r });
      });
    };
    go();
    return () => ctl.abort();
  }, [runId, wanted]);
  return state && state.run === runId ? state : null;
}

function AxialMaps({ axial, u }: { axial: AxialState | null; u: Units }) {
  const len = u.scale('length');
  const maps = useMemo(() => {
    const a = axial?.data;
    if (!a) return null;
    // The wall stations' transient solution: the same model as the figures and line charts above
    // (the sidecar's `profile` is a quasi-steady load at the ablation temperature, a different
    // basis, and its wall temperature is one number per step, not a field).
    const x = a.x_mm.map((v) => len.to(v / 1000));
    const names = a.station?.length === a.x_mm.length ? ` (${a.station.join(', ')})` : '';
    return { x, t: a.t, q: a.q_MW_m2, T: a.T_wall_K, basis: `At the wall's ${a.x_mm.length} stations${names}. ${a.basis ?? ''}` };
  }, [axial, len]);
  const placeholder = axial ? (axial.missing ?? 'Not computed for this run') : 'Loading…';
  const where = `Along the engine, measured from the throat (0), the injector side negative.`;
  return (
    <>
      <Panel title={<Hint text={`The net heat load into the wall at each station, at the cursor (solid) and the most it reached in the burn (dashed). It is taken at the wall's own surface temperature, so it falls as the surface heats and sits below the solver's throat and chamber heat flux. ${where} ${maps?.basis ?? ''}`}>Heat load along the engine</Hint>} className="lg:col-span-6">
        {maps ? <AlongEngine x={maps.x} t={maps.t} z={maps.q} unit="MW/m²" xLabel={`${len.unit} (throat)`} digits={1}
                             title="Heat load along the engine" />
          : <NotComputed height={220}>{placeholder}</NotComputed>}
      </Panel>
      <Panel title={<Hint text={`The wall's hot-side temperature at each station, at the cursor (solid) and the most it reached in the burn (dashed). ${where} ${maps?.basis ?? ''}`}>Wall temperature along the engine</Hint>} className="lg:col-span-6">
        {maps ? <AlongEngine x={maps.x} t={maps.t} z={maps.T} unit="K" xLabel={`${len.unit} (throat)`} digits={0}
                             title="Wall temperature along the engine" />
          : <NotComputed height={220}>{placeholder}</NotComputed>}
      </Panel>
    </>
  );
}

/** A field along the engine: its value at each station at the cursor, and the most it reached. */
function AlongEngine({ x, t, z, unit, xLabel, digits, title }: {
  x: readonly number[]; t: readonly number[]; z: readonly (readonly (number | null)[])[];
  unit: string; xLabel: string; digits: number; title: string;
}) {
  const k = useClockIndex(t);
  const series = useMemo<ChartSeries[]>(() => {
    const peak = x.map((_, j) => {
      let m: number | null = null;
      for (const row of z) { const v = row[j]; if (v !== null && Number.isFinite(v) && (m === null || v > m)) m = v; }
      return m;
    });
    const now = z.length ? z[Math.min(Math.max(0, k), z.length - 1)] : [];
    return [
      { key: 'peak', label: 'Peak', color: '--lx-text-2', dash: [4, 3], values: peak },
      { key: 'now', label: 'Cursor', color: '--lx-hot', values: [...now], width: 2 },
    ];
  }, [x, z, k]);
  return <Chart t={x} series={series} yUnit={unit} xLabel={xLabel} height={220} store={null} digits={digits} title={title} />;
}

// ------------------------------------------------------------------ separation, soak

function SeparationPanel({ data, hw }: { data: RunData; hw: HardwareDiag }) {
  const u = useUnits();
  const sep = hw.separation;
  const pa = u.scale('pressure', { pressure: 'abs' });
  const series = useMemo<ChartSeries[] | null>(() => {
    if (!sep) return null;
    const pe = colOf(sep.pe_pa, hw.t.length);
    // The exit pressure below which the nozzle separates in this ambient (DATA-CONTRACT 3,
    // schmucker_pe_sep_psia), plotted against the exit pressure; not the ambient threshold.
    const crit = colOf(sep.schmucker_pe_sep_psia, hw.t.length);
    if (!pe) return null;
    return [
      ...(crit ? [{ key: 'sep_crit', label: 'Separates below', color: '--lx-bad', dash: [4, 3], values: conv(crit, pa.to) }] : []),
      { key: 'sep_pe', label: 'Exit pressure', color: '--lx-hot', values: conv(pe.map((v) => (v === null ? null : v / PSI)), pa.to) },
    ];
  }, [sep, hw.t, pa]);
  const summerfield = sep?.summerfield?.some(Boolean) ?? false;
  return (
    <Panel title={<Hint text="The nozzle's exit pressure against the pressure at which the flow would separate from the wall (Schmucker), and the Summerfield check.">Nozzle separation</Hint>}
           right={sep ? (sep.flag || summerfield ? <Badge status="bad" size="sm">Separates</Badge> : <span>attached throughout</span>) : undefined} className="lg:col-span-6">
      {series ? <Chart t={hw.t} series={series} yUnit={pa.unit} height={200} events={data.events} digits={1} /> : <NotComputed height={200} />}
    </Panel>
  );
}

function SoakPanel({ data, hw }: { data: RunData; hw: HardwareDiag }) {
  const u = useUnits();
  const soak = hw.soak;
  const back = colOf(hw.insert_back_K, hw.t.length);
  const bound = isAdiabatic(soak?.basis) || isAdiabatic(hw.insert_back_basis);
  const series = useMemo<ChartSeries[] | null>(() => (back ? [{ key: 'insert_back', label: 'Insert back face', color: '--lx-hot', values: back }] : null), [back]);
  return (
    <Panel title={<Hint text="After shutdown the hot insert keeps heating what it touches. The peak here is with no heat lost to anything else, so the real one is lower.">Soak-back</Hint>}
           right={bound ? <span>adiabatic upper bound</span> : undefined} className="lg:col-span-6">
      {soak && soak.available !== false ? (
        <div className="grid grid-cols-3 gap-x-6">
          <Figure label={bound ? 'Peak, at most' : 'Peak'} q={u.temp(soak.peak_K ?? null)} sub={soak.station ?? undefined} />
          <Figure label="When" value={soak.t_peak_s === null || soak.t_peak_s === undefined ? '—' : `+${fmt(soak.t_peak_s, soak.t_peak_s < 10 ? 2 : 0)}`} unit="s" sub="after burnout" />
          <Figure label="Followed for" value={soak.duration_s === null || soak.duration_s === undefined ? "—" : String(Math.round(soak.duration_s))} unit="s" />
        </div>
      ) : <NotComputed height={60}>Soak-back not computed for this run</NotComputed>}
      {series && <Chart t={hw.t} series={series} yUnit="K" height={150} events={data.events} digits={0} className="mt-3" />}
    </Panel>
  );
}

// ------------------------------------------------------------------ the page

export function Hardware({ data, vs, job }: PageProps) {
  const u = useUnits();
  const replay = data.result.replay as ReplayPlus | undefined;
  const vsReplay = vs?.result.replay as ReplayPlus | undefined;
  const d = useMemo(() => diag(data.result), [data.result]);
  const hw = d.hardware;
  const runId = job.run?.id;
  // The run says when it wrote the axial sidecar; asking otherwise is a 404 in the console.
  const hasAxial = typeof hw?.heatmap === 'string' && hw.heatmap.includes('axial');
  const axial = useAxial(runId, hasAxial);
  const ch = useMemo(() => {
    if (!replay?.available) return null;
    const pct = u.scale('percent');
    const len = u.scale('length');
    const t = replay.t;
    const g = (pick: (r: ReplayPlus) => readonly (number | null)[] | null | undefined, to: (x: number) => number): ChartSeries[] => {
      const v = vsReplay?.available ? pick(vsReplay) : null;
      return v ? [{ key: 'vs', label: '', color: '', ghost: true, values: conv(alignOnto(t, vsReplay!.t, v), to) }] : [];
    };
    const growth = (r: ReplayPlus) => r.throat_area_ratio.map((x) => (x === null ? null : x - 1));
    const mmToM = (x: number) => len.to(x / 1000);
    return {
      t,
      lenUnit: len.unit,
      lenDigits: len.digits,
      growth: [...g(growth, pct.to), { key: 'growth', label: 'Throat area', color: '--lx-hot', values: conv(growth(replay), pct.to) }] as ChartSeries[],
      recession: [
        ...g((r) => r.recession_throat_mm, mmToM),
        { key: 'rec_throat', label: 'Throat', color: '--lx-hot', values: conv(replay.recession_throat_mm, mmToM) },
        ...(replay.recession_chamber_mm ? [{ key: 'rec_chamber', label: 'Chamber', color: '--lx-text-2', dash: [4, 3], values: conv(replay.recession_chamber_mm, mmToM) }] : []),
      ] as ChartSeries[],
      heat: replay.heat_flux_throat_MW_m2 ? [
        { key: 'q_throat', label: 'Throat', color: '--lx-hot', values: conv(replay.heat_flux_throat_MW_m2, (x) => x) },
        ...(replay.heat_flux_chamber_MW_m2 ? [{ key: 'q_chamber', label: 'Chamber', color: '--lx-text-2', dash: [4, 3], values: conv(replay.heat_flux_chamber_MW_m2, (x) => x) }] : []),
      ] as ChartSeries[] : null,
      temp: replay.T_graphite_surface_K ? [
        { key: 'T_graphite', label: 'Graphite', color: '--lx-hot', values: conv(replay.T_graphite_surface_K, (x) => x) },
        ...(replay.T_liner_surface_K ? [{ key: 'T_liner', label: 'Liner', color: '--lx-text-2', dash: [4, 3], values: conv(replay.T_liner_surface_K, (x) => x) }] : []),
      ] as ChartSeries[] : null,
    };
  }, [replay, vsReplay, u]);

  // The geometry small multiples: the diagnostics' when they are there, the replay's else.
  const geo = useMemo(() => {
    const len = u.scale('length');
    const out: { key: string; title: string; t: readonly number[]; series: ChartSeries[]; unit: string; digits: number; term?: string }[] = [];
    const ht = hw?.t ?? [];
    const dThroat = hw ? colOf(hw.throat_d_mm, ht.length) : null;
    const liner = hw ? colOf(hw.liner_min_mm, ht.length) : null;
    const lstar = hw ? colOf(hw.Lstar_m, ht.length) : null;
    const eps = hw ? colOf(hw.eps, ht.length) : null;
    if (dThroat) out.push({ key: 'dt', title: 'Throat diameter', t: ht, series: [{ key: 'dt', label: '', color: '--lx-hot', values: conv(dThroat, (x) => len.to(x / 1000)) }], unit: len.unit, digits: len.digits });
    else if (ch) out.push({ key: 'growth', title: 'Throat area growth', t: ch.t, series: ch.growth, unit: '%', digits: 1 });
    if (liner) out.push({ key: 'liner', title: 'Thinnest liner', t: ht, series: [{ key: 'liner', label: '', color: '--lx-text', values: conv(liner, (x) => len.to(x / 1000)) }], unit: len.unit, digits: len.digits });
    const L = lstar ? { t: ht, v: lstar } : replay?.Lstar_m?.length ? { t: replay.t, v: replay.Lstar_m } : null;
    if (L) out.push({ key: 'lstar', title: 'L*', t: L.t, series: [{ key: 'lstar', label: '', color: '--lx-text', values: conv(L.v, (x) => len.to(x)) }], unit: len.unit, digits: 0 });
    const E = eps ? { t: ht, v: eps } : replay?.eps?.length ? { t: replay.t, v: replay.eps } : null;
    if (E) out.push({ key: 'eps', title: 'Expansion ratio', t: E.t, series: [{ key: 'eps', label: '', color: '--lx-text', values: E.v }], unit: '', digits: 2 });
    return out;
  }, [hw, ch, replay, u]);

  if (!replay?.available && !hw) {
    return (
      <Panel title="Nozzle erosion">
        <NotComputed>{replay?.error ?? 'Not replayed: turn on Nozzle erosion in the rail'}</NotComputed>
      </Panel>
    );
  }
  const ev = data.events;
  const passes = data.result.passes ?? [];
  const dv = data.result.delivered?.summary;
  const span = { 1: 'lg:col-span-12', 2: 'lg:col-span-6', 3: 'lg:col-span-4', 4: 'lg:col-span-3' }[geo.length] ?? 'lg:col-span-3';
  const liner = hw ? colOf(hw.liner_min_mm, hw.t.length) : null;
  const soakBound = isAdiabatic(hw?.soak?.basis) || isAdiabatic(hw?.insert_back_basis);
  const failed = diagFailed(data.result, 'hardware');
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      <Panel ariaLabel="Erosion figures" className="lg:col-span-12">
        <FigureRow>
          <Figure label="Throat area" q={u.pct(dv?.throat_area_growth ?? (replay ? last(replay.throat_area_ratio.map((x) => (x === null ? null : x - 1))) : null))} sub="growth by burnout" />
          <Figure label="Throat recession" termKey="throatRecession" q={u.len(((dv?.throat_recession_mm ?? last(replay?.recession_throat_mm)) ?? NaN) / 1000)} sub="by burnout" />
          {liner && <Figure label="Thinnest liner" q={u.len((last(liner) ?? NaN) / 1000)} sub="at burnout" />}
          {replay?.heat_flux_throat_MW_m2 && <Figure label="Throat heat flux" value={(peak(replay.heat_flux_throat_MW_m2) ?? NaN).toFixed(1)} unit="MW/m²" sub="peak" />}
          {replay?.T_graphite_surface_K && <Figure label="Graphite surface" q={u.temp(peak(replay.T_graphite_surface_K))} sub="peak" />}
          {hw?.soak?.peak_K !== null && hw?.soak?.peak_K !== undefined && <Figure label="Soak-back" q={u.temp(hw.soak.peak_K)} sub={soakBound ? 'at most' : 'peak'} />}
        </FigureRow>
      </Panel>
      <Panel title="The engine through the burn" className="lg:col-span-12">
        {/* lx/hero's section, to scale, at the cursor; the change along the wall (cursor vs burnout) under it when the run carries the frames. */}
        <div className={hw?.contour?.frames ? 'grid grid-cols-1 gap-x-8 gap-y-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]' : ''}>
          <EngineSection result={data.result} maxHeight={hw?.contour?.frames ? 240 : 320} />
          {hw?.contour && (
            <div className="min-w-0">
              <div className="mb-1 text-[12px] text-[var(--lx-text-2)]">
                <Hint text="How far the wall has moved outward at each station along the engine: at the cursor, and by burnout.">Wall moved, along the engine</Hint>
              </div>
              <RecessionAlong contour={hw.contour} u={u} />
            </div>
          )}
        </div>
        {failed && <div className="mt-2 text-[12px] text-[var(--lx-text-3)]">{diagMissing(data.result, 'hardware')}</div>}
      </Panel>
      {geo.map((x) => (
        <ChartPanel key={x.key} title={x.title} className={span} t={x.t} series={x.series} yUnit={x.unit} height={170} events={ev} digits={x.digits} />
      ))}
      {hasAxial && <AxialMaps axial={axial} u={u} />}
      {ch && <ChartPanel title="Heat flux" className="lg:col-span-6" t={ch.t} series={ch.heat ?? []} yUnit="MW/m²" height={220} events={ev} digits={1} empty={!ch.heat} />}
      {ch && <ChartPanel title="Wall surface" className="lg:col-span-6" t={ch.t} series={ch.temp ?? []} yUnit="K" height={220} events={ev} digits={0} empty={!ch.temp} />}
      {hw?.separation && <SeparationPanel data={data} hw={hw} />}
      {hw && (hw.soak || hw.insert_back_K) && <SoakPanel data={data} hw={hw} />}
      {ch && <ChartPanel title="Recession" className="lg:col-span-12" t={ch.t} series={ch.recession} yUnit={ch.lenUnit} height={200} events={ev} digits={ch.lenDigits} />}
      <Panel title="Passes" right={<span>{data.result.converged === false ? 'not settled' : 'settled'}</span>} className="lg:col-span-12">
        {passes.length ? (
          <Table caption="Each pass of the burn and what it fed back"
                 head={['Pass', 'Throat', 'Burn', 'Throat growth', 'History moved', 'Twin vs replay, flow / Pc']}
                 align={['l', 'l', 'r', 'r', 'r', 'r']}
                 rows={passes.map((p) => [
                   p.pass,
                   [p.throat_applied ? 'previous replay' : 'as built', p.accel_applied ? ' · flight g' : ''].join(''),
                   u.fmt(u.time(p.burn_time_s)),
                   p.throat_growth === null ? '—' : u.fmt(u.pct(p.throat_growth)),
                   `${(p.schedule_change * 100).toFixed(3)}${NBSP}%`,
                   p.agreement.worst ? `${u.fmt(u.pct(Math.max(p.agreement.worst.mdot_O, p.agreement.worst.mdot_F)))} / ${u.fmt(u.pct(p.agreement.worst.pc))}` : '—',
                 ])} />
        ) : <NotComputed height={48} />}
      </Panel>
      <NotYet items={[
        !hw && !failed && 'the wall along the engine through the burn, throat diameter and liner',
        !hasAxial && !failed && 'heat flux and wall temperature along the engine',
        !hw?.separation && !failed && 'nozzle separation',
        !hw?.soak && !hw?.insert_back_K && !failed && 'soak-back',
      ].filter((x): x is string => !!x)} />
    </div>
  );
}
