import { useMemo, type ReactElement } from 'react';
import { VERDICT } from '../../layerx/format';
import { Chart } from '../charts/Chart';
import { alignOnto } from '../charts/resample';
import type { ChartBand, ChartLimit, ChartSeries, ChartWorst } from '../charts/types';
import { colAt, colOf, diag, diagFailed, diagMissing, type Col, type Diagnostics, type HardwareDiag, type StabilityDiag, type StartDiag } from '../contract';
import { useCursorIndex } from '../time/hooks';
import { formatT } from '../time/markers';
import { Badge, Figure, NotComputed, Panel } from '../ui';
import { NBSP, useUnits, type Units } from '../units';
import { argExtreme, convert as conv, figureDelta, ghostSeries as ghost, type RunData } from '../useRunData';
import { ChartPanel, FigureRow, Hint, NotYet, Readout, SideName, Table } from './kit';
import type { PageProps } from './Overview';
import { spanText, useClockIndex, type SideKey } from './side';
import { XYPlot, type XYLine, type XYPoint } from './XYPlot';

/**
 * Engine asks "What does the chamber see?": chamber pressure and thrust, the burn's path over
 * (O/F, Pc) against the design point and the injector's limits, where the Isp goes, the
 * injector's stiffness and momentum balance, the chug margin with its frequency, Nyquist locus
 * and sensitivity to the lag, the line acoustics against the chug frequency, and the start.
 */

const SPAN: Record<number, string> = { 1: 'lg:col-span-12', 2: 'lg:col-span-6', 3: 'lg:col-span-4', 4: 'lg:col-span-3' };

/** The replay's ηc* when the run carries it (it is not in the typed API yet). */
function etaOf(data: RunData): { t: number[]; values: (number | null)[] } | null {
  const inj = diag(data.result).injector;
  const fromDiag = inj ? colOf(inj.eta_cstar, inj.t.length) : null;
  if (inj && fromDiag) return { t: inj.t, values: fromDiag };
  const r = data.result.replay as unknown as { t?: number[]; eta_cstar?: (number | null)[] } | undefined;
  return r?.t && r.eta_cstar?.length ? { t: r.t, values: r.eta_cstar } : null;
}

/** The chug margin on the active basis: the diagnostics' series, else the replay's on the twin's clock. */
function chugOf(data: RunData, st: StabilityDiag | undefined): { t: number[]; values: Col } | null {
  const m = st ? colOf(st.margin, st.t.length) : null;
  if (st && m) return { t: st.t, values: m };
  return data.cols.chug ? { t: data.t, values: data.cols.chug } : null;
}

const BASIS_WORDS: Record<string, string> = { config: "design's feed", drawing: "drawing's lines" };

// ------------------------------------------------------------------ the operating map

function OperatingMap({ data, vs, d }: { data: RunData; vs: RunData | null; d: Diagnostics }) {
  const u = useUnits();
  const i = useCursorIndex();
  const pa = u.scale('pressure', { pressure: 'abs' });
  const om = d.opmap;
  const ledgerRows = d.ledger;
  const geo = useMemo(() => {
    const n = data.t.length;
    const path = { of: data.cols.of, pc: data.cols.pc };
    const lines: XYLine[] = [];
    for (const c of om?.chug_unstable ? [om.chug_unstable] : []) {
      lines.push({ key: 'chug_region', label: '', color: '--lx-bad', x: c.of, y: c.pc_psia.map(pa.to), fill: true, scale: false });
    }
    for (const b of om?.boundaries ?? []) {
      lines.push({ key: b.key, label: b.label, color: '--lx-bad', dash: '4 3', width: 1, x: b.of, y: b.pc_psia.map(pa.to), scale: false });
    }
    if (vs) lines.push({ key: 'vs', label: '', color: '', ghost: true, x: vs.cols.of, y: conv(vs.cols.pc, pa.to) });
    lines.push({ key: 'burn', label: 'Burn', color: '--lx-hot', width: 2, x: path.of, y: conv(path.pc, pa.to) });
    // One design point for the whole page: the ledger's (Forward mode at the set tank pressure), which
    // the figures and the "design assumed" table quote. provenance.engine_reference is the engine
    // alone at the line-exit pressures, another O/F (1.45 vs 1.52 on LE4) that made the map read
    // as a different burn; it is used only for a run that has no ledger.
    const ledger = Array.isArray(ledgerRows) ? ledgerRows : [];
    const lo = ledger.find((l) => l.key === 'of')?.design_value;
    const lp = ledger.find((l) => l.key === 'pc')?.design_value;
    const ref = data.result.provenance.engine_reference;
    const design = om?.design
      ?? (typeof lo === 'number' && typeof lp === 'number' ? { of: lo, pc_psia: lp }
        : ref && Number.isFinite(ref.MR) && Number.isFinite(ref.Pc) ? { of: ref.MR, pc_psia: ref.Pc / 6894.757 } : null);
    const points: XYPoint[] = [];
    const first = data.firing.indexOf(true);
    if (first >= 0 && path.of[first] !== null && path.pc[first] !== null) {
      points.push({ key: 'start', x: path.of[first] as number, y: pa.to(path.pc[first] as number), color: '--lx-text-3', shape: 'dot' });
    }
    if (design) points.push({ key: 'design', x: design.of, y: pa.to(design.pc_psia), color: '--lx-text', shape: 'ring', label: 'design' });
    return { lines, points, n };
  }, [data, vs, om, pa, ledgerRows]);
  const x = i >= 0 ? data.cols.of[i] ?? null : null;
  const y = i >= 0 ? data.cols.pc[i] ?? null : null;
  const missingBits = [!om?.boundaries?.length && 'ΔP/Pc limits', !om?.isp_grid && 'Isp contours', !om?.chug_unstable && 'chug region'].filter(Boolean);
  return (
    <Panel title={<Hint text="The burn as a path over O/F and chamber pressure, against the point the engine was designed for. The dot follows the time cursor.">Operating map</Hint>}
           right={missingBits.length ? <span>{missingBits.join(', ')}: not computed</span> : undefined} className="lg:col-span-7">
      <XYPlot title="The burn's path over O/F and chamber pressure" lines={geo.lines} points={geo.points} xUnit="O/F" yUnit={pa.unit} height={300}
              cursor={{ x, y: y === null ? null : pa.to(y), color: '--lx-hot' }} />
      {/* TODO(charts): Isp contours under the path once diagnostics.opmap.isp_grid lands and lx/charts can draw them. */}
    </Panel>
  );
}

// ------------------------------------------------------------------ Isp

function IspPanel({ data, hw, fallback }: { data: RunData; hw: HardwareDiag | undefined; fallback: ChartSeries[] }) {
  const u = useUnits();
  const isp = hw?.isp ?? null;
  const t = hw?.t ?? data.t;
  const k = useClockIndex(hw?.t);
  const series = useMemo<ChartSeries[] | null>(() => {
    if (!isp) return null;
    const ideal = colOf(isp.ideal_s, t.length);
    const delivered = colOf(isp.delivered_s, t.length);
    if (!delivered) return null;
    return [
      ...(ideal ? [{ key: 'isp_ideal', label: 'Ideal', color: '--lx-text-3', dash: [4, 3], values: ideal }] : []),
      { key: 'isp', label: 'Delivered', color: '--lx-hot', values: delivered, width: 2 },
    ];
  }, [isp, t]);
  if (!series) {
    return <ChartPanel title="Isp" className="lg:col-span-5" t={data.t} series={fallback} yUnit="s" height={300} events={data.events} digits={1} />;
  }
  const parts = [
    { key: 'delivered', label: 'Delivered', v: colAt(isp?.delivered_s, k), fill: 'var(--lx-hot)' },
    { key: 'cstar', label: 'c* loss', v: colAt(isp?.cstar_loss_s, k), fill: 'color-mix(in srgb, var(--lx-hot) 45%, transparent)' },
    { key: 'nozzle', label: 'Nozzle loss', v: colAt(isp?.nozzle_loss_s, k), fill: 'color-mix(in srgb, var(--lx-hot) 20%, transparent)' },
  ];
  const ideal = colAt(isp?.ideal_s, k) ?? parts.reduce((a, p) => a + (p.v ?? 0), 0);
  return (
    <Panel title={<Hint text="The ideal (shifting-equilibrium) Isp, what combustion efficiency takes off it, what the nozzle takes off it, and what is left.">Where the Isp goes</Hint>}
           right={<span className="lx-num">{k >= 0 ? `at ${formatT(t[k])}` : ''}</span>} className="lg:col-span-5">
      <div className="flex h-3.5 overflow-hidden rounded-[3px] bg-[var(--lx-line)]" role="img"
           aria-label={parts.map((p) => `${p.label} ${u.fmt(u.isp(p.v))}`).join(', ')}>
        {parts.map((p) => <div key={p.key} style={{ width: `${Math.max(0, (p.v ?? 0) / (ideal || 1)) * 100}%`, background: p.fill }} />)}
      </div>
      <div className="mt-2 grid grid-cols-4 gap-x-3 text-[11px]">
        {[...parts, { key: 'ideal', label: 'Ideal', v: ideal, fill: 'transparent' }].map((p) => (
          <div key={p.key} className="min-w-0">
            <div className="flex items-center gap-1.5 truncate text-[var(--lx-text-3)]">
              <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-[1px] border border-[var(--lx-line-strong)]" style={{ background: p.fill }} />{p.label}
            </div>
            <div className="lx-num text-[13px] text-[var(--lx-text)]">{u.fmt(u.isp(p.v))}</div>
          </div>
        ))}
      </div>
      <Chart t={t} series={series} yUnit="s" height={196} events={data.events} digits={1} className="mt-3" />
    </Panel>
  );
}

// ------------------------------------------------------------------ stability

function ChugSummary({ data, st, chug }: { data: RunData; st: StabilityDiag | undefined; chug: { t: number[]; values: Col } | null }) {
  const u = useUnits();
  const dv = data.result.delivered?.summary;
  const k = chug ? argExtreme(chug.values, 'min') : -1;
  // The graded figure first (DATA-CONTRACT 1, D7: today's basis, the whole burn), so this page and
  // the Overview's bar say the same number; then the stability block's own, then the replay's.
  const graded = data.limits.find((l) => l.key === 'chug_margin');
  const worst = graded && graded.value !== null
    ? { t: graded.worstT ?? NaN, margin: graded.value, frequency_hz: st?.worst?.frequency_hz ?? null }
    : st?.worst ?? (dv?.chug_margin_min !== null && dv?.chug_margin_min !== undefined
      ? { t: dv.chug_margin_min_t ?? (k >= 0 ? chug!.t[k] : NaN), margin: dv.chug_margin_min, frequency_hz: null } : null);
  const other = st?.other_basis;
  return (
    <Panel title="Chug" right={st?.basis ? <span>on the {BASIS_WORDS[st.basis] ?? st.basis}</span> : undefined} className="lg:col-span-4">
      <div className="grid grid-cols-2 gap-x-6 gap-y-5">
        <Figure label="Lowest margin" termKey="chugMargin" q={u.ratio(worst?.margin ?? null)} sub={worst && Number.isFinite(worst.t) ? `at ${formatT(worst.t)}` : undefined} />
        <Figure label="Frequency then" termKey="chugFrequency" q={u.hz(worst?.frequency_hz ?? null)} />
        <Figure label="Lowest once settled" q={u.ratio(st?.settled_min?.margin ?? null)}
                sub={st?.start_window_s ? `after ${u.fmt(u.time(st.start_window_s))}` : undefined} />
        <Figure label={other ? `On the ${BASIS_WORDS[other.basis] ?? other.basis}` : 'Other basis'} q={u.ratio(other?.margin_min ?? null)}
                sub={other?.t !== null && other?.t !== undefined ? `at ${formatT(other.t)}` : undefined} />
      </div>
    </Panel>
  );
}

function Nyquist({ st }: { st: StabilityDiag }) {
  const ny = st.nyquist!;
  const lines: XYLine[] = [{ key: 'locus', label: '', color: '--lx-text', x: ny.re, y: ny.im }];
  const points: XYPoint[] = [{ key: 'crit', x: -1, y: 0, color: '--lx-bad', shape: 'cross', label: '−1' }];
  return (
    <Panel title={<Hint text="The feed-coupled loop's open-loop response at the worst moment, swept over frequency. The loop is stable while the locus stays to the right of −1; the gain margin is how far.">Nyquist</Hint>}
           right={<span className="lx-num">at {formatT(ny.t)}</span>} className="lg:col-span-4">
      <XYPlot title="Nyquist locus of the chug loop" lines={lines} points={points} xUnit="Re" yUnit="Im" height={220} square />
    </Panel>
  );
}

function TauSweep({ st }: { st: StabilityDiag }) {
  const tau = st.tau_sweep!;
  const series = useMemo<ChartSeries[]>(() => [{ key: 'tau', label: 'Margin', color: '--lx-text', values: tau.margin }], [tau]);
  const limits = useMemo<ChartLimit[]>(() => [{ value: 1, status: 'bad', label: 'unstable below 1' }], []);
  const events = useMemo(() => (tau.nominal_ms ? [{ t: tau.nominal_ms, key: 'nominal', label: 'nominal', kind: 'fire' }] : []), [tau.nominal_ms]);
  return (
    <Panel title={<Hint text="The lowest chug margin if the combustion time lag were longer or shorter than the model's. The tick marks the lag the burn used.">Sensitivity to the time lag</Hint>}
           className="lg:col-span-4" bodyClassName="!pt-1">
      <Chart t={tau.tau_ms} series={series} yUnit="" xLabel="ms" height={220} limits={limits} events={events} digits={2} store={null} />
    </Panel>
  );
}

/** The backend writes a side as 'ox' or 'oxidiser' depending on the block. */
const sideKeyOf = (s: string | null | undefined): SideKey | null => (s === 'ox' || s === 'oxidiser' || s === 'oxidizer' ? 'ox' : s === 'fuel' ? 'fuel' : s === 'gas' ? 'gas' : null);

function Acoustics({ st }: { st: StabilityDiag | undefined }) {
  const u = useUnits();
  const rows = st?.acoustic ?? [];
  const f = st?.worst?.frequency_hz ?? null;
  return (
    <Panel title={<Hint text="Each line's organ-pipe modes (open-closed quarter wave, closed-closed half wave) against the chug frequency: a mode near it can couple.">Line acoustics</Hint>}
           right={f !== null ? <span className="lx-num">chug {u.fmt(u.hz(f))}</span> : undefined} className="lg:col-span-6">
      <Table caption="Line acoustic modes against the chug frequency" head={[{ sr: 'Line' }, 'Length', '¼ wave', '½ wave', { sr: 'Near chug' }]} align={['l', 'r', 'r', 'r', 'l']}
             rows={rows.map((a) => [
               <SideName key="n" side={sideKeyOf(a.side)}>{a.line}</SideName>,
               u.fmt(u.len(a.length_m)),
               u.fmt(u.hz(a.f_quarter_hz)),
               u.fmt(u.hz(a.f_half_hz)),
               a.near_chug ? <Badge key="b" status="warn" size="sm">near chug</Badge> : <span key="b" className="font-sans text-[var(--lx-text-3)]">clear</span>,
             ])} />
    </Panel>
  );
}

// ------------------------------------------------------------------ start and shutdown

function StartPanel({ start, shutdown }: { start: StartDiag | undefined; shutdown: Diagnostics['shutdown'] }) {
  const u = useUnits();
  const pa = u.scale('pressure', { pressure: 'abs' });
  const st = start?.t?.length ? start : null;
  const series = useMemo<ChartSeries[] | null>(() => {
    if (!st?.t) return null;
    const pc = colOf(st.pc_psia, st.t.length);
    return pc ? [{ key: 'start_pc', label: 'Chamber', color: '--lx-hot', values: conv(pc, pa.to) }] : null;
  }, [st, pa]);
  const mr = useMemo<ChartSeries[] | null>(() => {
    if (!st?.t) return null;
    const m = colOf(st.mr, st.t.length);
    return m ? [{ key: 'start_mr', label: 'O/F', color: '--lx-text', values: m }] : null;
  }, [st]);
  const mrRange = mr ? mr[0].values.filter((x): x is number => x !== null) : [];
  const sideWord = (s: string | undefined) => (s === 'ox' ? 'LOX' : s === 'fuel' ? 'Fuel' : s ?? '—');
  return (
    <Panel title={<Hint text="The first moments after Fire: the valves travel, each side's manifold fills, the propellants meet and light. And how the burn ends: which side runs out first, and how rich the tail runs.">Start and shutdown</Hint>}
           right={start?.hard_start ? <Badge status="bad" size="sm">Hard start</Badge> : start ? <span>no hard start</span> : undefined} className="lg:col-span-6">
      {start ? (
        <Readout items={[
          { label: 'Fuel lead', value: u.fmt(u.time(start.fuel_lead_s ?? null)) },
          { label: 'Valve travel', value: u.fmt(u.time(start.valve_travel_s ?? null)) },
          { label: 'LOX primed', value: start.prime_ox_s === null || start.prime_ox_s === undefined ? '—' : formatT(start.prime_ox_s) },
          { label: 'Fuel primed', value: start.prime_fuel_s === null || start.prime_fuel_s === undefined ? '—' : formatT(start.prime_fuel_s) },
          { label: 'Ignition', value: start.ignition_s === null || start.ignition_s === undefined ? '—' : formatT(start.ignition_s) },
          { label: 'O/F at start', value: mrRange.length ? `${u.fmt(u.of(Math.min(...mrRange)))} – ${u.fmt(u.of(Math.max(...mrRange)))}` : '—' },
          { label: 'Impulse lost', value: u.fmt(u.impulse(start.impulse_deficit_Ns ?? null)) },
        ]} />
      ) : <NotComputed height={48}>Start not computed for this run</NotComputed>}
      {st?.t && (series || mr) && (
        <div className="mt-3 grid grid-cols-2 gap-4">
          {series ? <Chart t={st.t} series={series} yUnit={pa.unit} xLabel="s" height={140} store={null} /> : <span />}
          {mr ? <Chart t={st.t} series={mr} yUnit="O/F" xLabel="s" height={140} store={null} digits={2} /> : <span />}
        </div>
      )}
      <div className="mt-4 border-t border-[var(--lx-line)] pt-3">
        {shutdown ? (
          <Readout items={[
            { label: 'Runs dry first', value: sideWord(shutdown.first_dry) },
            { label: 'Tail runs', value: shutdown.mode ?? '—' },
            { label: 'Tail O/F, peak', value: u.fmt(u.of(shutdown.tail_mr_max ?? null)) },
          ]} />
        ) : <div className="text-[12px] text-[var(--lx-text-3)]">Shutdown not computed for this run</div>}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ the page

function useEngineCharts(data: RunData, vs: RunData | null, u: Units, d: Diagnostics) {
  return useMemo(() => {
    const pa = u.scale('pressure', { pressure: 'abs' });
    const force = u.scale('force');
    const pct = u.scale('percent');
    const c = data.cols;
    // The lower side's worst moment is the one the band is graded on.
    const iO = argExtreme(c.stiffO, 'min');
    const iF = argExtreme(c.stiffF, 'min');
    const lowFuel = iF >= 0 && (iO < 0 || (c.stiffF[iF] as number) < (c.stiffO[iO] as number));
    const wi = lowFuel ? iF : iO;
    const band = data.band.oxidiser ?? data.band.fuel;
    const stiffBand: ChartBand | null = band ? { lo: pct.to(band[0]), hi: pct.to(band[1]), status: 'ok' } : null;
    const stiffLimits: ChartLimit[] = band ? [] : [{ value: pct.to(VERDICT.stiffnessFloor), status: 'bad', label: `min ${(VERDICT.stiffnessFloor * 100).toFixed(0)}${NBSP}%` }];
    const stiffWorst: ChartWorst | null = wi >= 0 ? {
      seriesKey: lowFuel ? 'stiff_fuel' : 'stiff_lox', index: wi,
      text: `min ${u.fmt(u.pct((lowFuel ? c.stiffF : c.stiffO)[wi]))} at ${formatT(data.t[wi])}`,
    } : null;

    const st = d.stability;
    const chug = chugOf(data, st);
    const chugVs = vs ? chugOf(vs, diag(vs.result).stability) : null;
    const ci = chug ? argExtreme(chug.values, 'min') : -1;
    const other = st?.other_basis;
    const otherCol = st && chug && chug.t === st.t ? colOf((st as StabilityDiag & { margin_other?: Col }).margin_other, st.t.length) : null;
    const chugSeries: ChartSeries[] | null = chug ? [
      ...(chugVs ? [{ key: 'chug_vs', label: '', color: '', ghost: true, values: alignOnto(chug.t, chugVs.t, chugVs.values) }] : []),
      // The other feed basis through the burn (DATA-CONTRACT 3 stability.margin_other, on the same
      // replay points); a run that carries only its minimum draws that as a flat line.
      ...(otherCol && otherCol.length === chug.t.length
        ? [{ key: 'chug_other', label: `${BASIS_WORDS[other?.basis ?? ''] ?? `${other?.basis} basis`}`, color: '--lx-text-3', dash: [2, 3], values: otherCol }]
        : other?.margin_min !== null && other?.margin_min !== undefined
          ? [{ key: 'chug_other', label: `${BASIS_WORDS[other.basis] ?? `${other.basis} basis`}, lowest`, color: '--lx-text-3', dash: [2, 3], values: chug.t.map(() => other.margin_min) }] : []),
      { key: 'chug', label: 'Chug margin', color: '--lx-text', values: chug.values },
    ] : null;

    const inj = d.injector;
    const mr = inj ? colOf(inj.momentum_ratio, inj.t.length) : null;
    const angle = inj ? colOf(inj.resultant_angle_deg, inj.t.length) : null;
    const freq = st ? colOf(st.frequency_hz, st.t.length) : null;
    const eta = etaOf(data);
    const etaVs = vs ? etaOf(vs) : null;
    const target = d.thrust_shape?.target_N ?? null;
    return {
      units: { pa: pa.unit, f: force.unit },
      pc: [...ghost('pc', data, vs, (x) => x.cols.pc, pa.to), { key: 'pc', label: 'Chamber', color: '--lx-hot', values: conv(c.pc, pa.to), width: 2 }] as ChartSeries[],
      thrust: [
        ...ghost('thrust', data, vs, (x) => x.cols.thrust, force.to),
        ...(c.thrustAsBuilt ? [{ key: 'thrust_built', label: 'As built', color: '--lx-text-3', dash: [3, 3], values: conv(c.thrustAsBuilt, force.to) }] : []),
        ...(target !== null ? [{ key: 'thrust_target', label: 'Target', color: '--lx-text-3', dash: [2, 3], values: data.t.map((_, k) => (data.firing[k] ? force.to(target) : null)) }] : []),
        { key: 'thrust', label: 'Thrust', color: '--lx-hot', values: conv(c.thrust, force.to), width: 2 },
      ] as ChartSeries[],
      stiff: [
        ...ghost('stiff_lox', data, vs, (x) => x.cols.stiffO, pct.to),
        { key: 'stiff_lox', label: 'LOX', color: '--lx-lox', values: conv(c.stiffO, pct.to) },
        { key: 'stiff_fuel', label: 'Fuel', color: '--lx-fuel', values: conv(c.stiffF, pct.to) },
      ] as ChartSeries[],
      stiffBand, stiffLimits, stiffWorst,
      chug, chugSeries,
      chugLimits: [
        { value: 1, status: 'bad', label: 'unstable below 1' },
        { value: VERDICT.chugMarginWarn, status: 'warn', label: `${VERDICT.chugMarginWarn}` },
      ] as ChartLimit[],
      chugWorst: chug && ci >= 0 ? { seriesKey: 'chug', index: ci, text: `min ${u.fmt(u.ratio(chug.values[ci]))} at ${formatT(chug.t[ci])}` } as ChartWorst : null,
      freq: st && freq ? { t: st.t, series: [{ key: 'chug_hz', label: 'Chug', color: '--lx-text', values: freq }] as ChartSeries[] } : null,
      mr: inj && mr ? {
        t: inj.t,
        series: [
          ...(inj.design_momentum_ratio ? [{ key: 'mr_design', label: 'Design', color: '--lx-text-3', dash: [4, 3], values: inj.t.map(() => inj.design_momentum_ratio as number) }] : []),
          { key: 'mr', label: 'Burn', color: '--lx-text', values: mr },
        ] as ChartSeries[],
      } : null,
      angle: inj && angle ? { t: inj.t, series: [{ key: 'angle', label: 'Resultant', color: '--lx-text', values: angle }] as ChartSeries[] } : null,
      of: [...ghost('of', data, vs, (x) => x.cols.of), { key: 'of', label: 'O/F', color: '--lx-text', values: c.of }] as ChartSeries[],
      isp: [...ghost('isp', data, vs, (x) => x.cols.isp), { key: 'isp', label: 'Isp', color: '--lx-hot', values: c.isp }] as ChartSeries[],
      eta: eta ? {
        t: eta.t,
        series: [
          ...(etaVs ? [{ key: 'eta_vs', label: '', color: '', ghost: true, values: conv(alignOnto(eta.t, etaVs.t, etaVs.values), pct.to) }] : []),
          { key: 'eta', label: 'ηc*', color: '--lx-hot', values: conv(eta.values, pct.to) },
        ] as ChartSeries[],
      } : null,
    };
  }, [data, vs, u, d]);
}

export function Engine({ data, vs }: PageProps) {
  const u = useUnits();
  const d = useMemo(() => diag(data.result), [data.result]);
  const ch = useEngineCharts(data, vs, u, d);
  const f = data.figures;
  const r = vs?.figures;
  const res = data.result;
  const ev = data.events;
  const q = { pc: u.p(f.pcMeanPsia), f: u.f(f.meanThrustN), of: u.of(f.ofMean), isp: u.isp(f.ispMean) };
  const rq = r ? { pc: u.p(r.pcMeanPsia), f: u.f(r.meanThrustN), of: u.of(r.ofMean), isp: u.isp(r.ispMean) } : null;
  const chugMin = d.stability?.worst?.margin ?? res.delivered?.summary?.chug_margin_min ?? null;
  const ts = d.thrust_shape;
  const st = d.stability;

  // Small multiples in a row: whichever the run carries, sharing the row evenly.
  const smalls = [
    ch.mr && { key: 'mr', el: (span: string) => <ChartPanel key="mr" title={<Hint text="Fuel jet momentum over LOX jet momentum; it sets which way the spray fan leans.">Momentum ratio</Hint>} className={span} t={ch.mr!.t} series={ch.mr!.series} yUnit="" height={180} events={ev} digits={2} /> },
    ch.angle && { key: 'angle', el: (span: string) => <ChartPanel key="angle" title={<Hint text="How far the combined spray leans off the injector's axis.">Spray lean</Hint>} className={span} t={ch.angle!.t} series={ch.angle!.series} yUnit="°" height={180} events={ev} digits={1} /> },
    { key: 'of', el: (span: string) => <ChartPanel key="of" title="O/F" className={span} t={data.t} series={ch.of} yUnit="" height={180} events={ev} digits={2} /> },
    { key: 'eta', el: (span: string) => <ChartPanel key="eta" title="ηc*" className={span} t={ch.eta?.t ?? []} series={ch.eta?.series ?? []} yUnit="%" height={180} events={ev} digits={1} empty={!ch.eta} /> },
  ].filter((x): x is { key: string; el: (span: string) => ReactElement } => !!x);
  const stabRow = [
    ch.freq && <ChartPanel key="freq" title="Chug frequency" className="lg:col-span-4" t={ch.freq.t} series={ch.freq.series} yUnit="Hz" height={220} events={ev} digits={0} />,
    st?.nyquist && <Nyquist key="ny" st={st} />,
    st?.tau_sweep && <TauSweep key="tau" st={st} />,
  ].filter(Boolean);
  const failed = (k: keyof Diagnostics) => diagFailed(res, k);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      <Panel ariaLabel="Chamber figures" className="lg:col-span-12">
        <FigureRow min="8rem">
          <Figure label="Chamber pressure" termKey="pc" q={q.pc} delta={figureDelta(q.pc, rq?.pc)} sub={spanText(u, u.p(f.pcMinPsia), u.p(f.pcMaxPsia))} />
          <Figure label="Mean thrust" termKey="thrust" q={q.f} delta={figureDelta(q.f, rq?.f, 'pct')}
                  sub={ts?.dev_max_pct !== null && ts?.dev_max_pct !== undefined ? `±${ts.dev_max_pct.toFixed(1)}${NBSP}% at most` : spanText(u, u.f(f.minThrustN), u.f(f.peakThrustN))} />
          <Figure label="O/F" termKey="of" q={q.of} delta={figureDelta(q.of, rq?.of)} sub={`${u.fmt(u.of(f.ofMin))} – ${u.fmt(u.of(f.ofMax))}`} />
          <Figure label="Isp" termKey="isp" q={q.isp} delta={figureDelta(q.isp, rq?.isp)} sub={f.throatGrowth !== null ? `throat +${u.fmt(u.pct(f.throatGrowth))}` : 'delivered'} />
          <Figure label="LOX ΔP/Pc, lowest" termKey="stiffness" q={u.pct(res.summary.ox.stiffness_min)} />
          <Figure label="Fuel ΔP/Pc, lowest" termKey="stiffness" q={u.pct(res.summary.fuel.stiffness_min)} />
          {chugMin !== null && <Figure label="Chug margin, lowest" termKey="chugMargin" q={u.ratio(chugMin)} />}
        </FigureRow>
      </Panel>
      <ChartPanel title="Chamber pressure" className="lg:col-span-6" t={data.t} series={ch.pc} yUnit={ch.units.pa} height={260} events={ev} />
      <ChartPanel title="Thrust" className="lg:col-span-6" t={data.t} series={ch.thrust} yUnit={ch.units.f} height={260} events={ev} />
      <OperatingMap data={data} vs={vs} d={d} />
      <IspPanel data={data} hw={d.hardware} fallback={ch.isp} />
      <ChartPanel title="Injector ΔP/Pc" className="lg:col-span-12" t={data.t} series={ch.stiff} yUnit="%" height={220} events={ev} digits={1}
                  band={ch.stiffBand} limits={ch.stiffLimits} worst={ch.stiffWorst} />
      {smalls.map((s) => s.el(SPAN[smalls.length] ?? 'lg:col-span-3'))}
      <ChartPanel title="Chug margin" className={st ? 'lg:col-span-8' : 'lg:col-span-12'} t={ch.chug?.t ?? []} series={ch.chugSeries ?? []} yUnit="" height={240} events={ev} digits={2}
                  limits={ch.chugLimits} worst={ch.chugWorst} empty={!ch.chugSeries} />
      {st && <ChugSummary data={data} st={st} chug={ch.chug} />}
      {stabRow.length > 0 && stabRow.length < 3
        ? <div className="contents">{stabRow}</div>
        : stabRow}
      {(st?.acoustic?.length || failed('stability')) ? <Acoustics st={st} /> : null}
      {(d.start || d.shutdown || failed('start') || failed('shutdown')) ? <StartPanel start={d.start} shutdown={d.shutdown} /> : null}
      <NotYet items={[
        !st && !failed('stability') && 'chug frequency, Nyquist locus, lag sensitivity and line acoustics',
        st && !st.nyquist && 'Nyquist locus',
        st && !st.tau_sweep && 'lag sensitivity',
        !d.injector && !failed('injector') && 'momentum ratio and spray lean',
        !d.hardware?.isp && !failed('hardware') && 'Isp breakdown',
        !d.start && !d.shutdown && !failed('start') && 'start and shutdown',
      ].filter((x): x is string => !!x)} />
      {failed('stability') && <Panel title="Stability" className="lg:col-span-12"><NotComputed height={48}>{diagMissing(res, 'stability')}</NotComputed></Panel>}
    </div>
  );
}
