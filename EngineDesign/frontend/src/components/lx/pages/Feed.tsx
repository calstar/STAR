import { useMemo, type ReactNode } from 'react';
import { fmt } from '../../layerx/format';
import { Chart } from '../charts/Chart';
import { MiniSpark } from '../charts/MiniSpark';
import type { ChartSeries } from '../charts/types';
import {
  colAt, colOf, diag, diagFailed, diagMissing, networkOf, type CavitationSide, type Diagnostics, type PressurantDiag, type RegulatorDiag, type SolenoidDiag,
} from '../contract';
import { useCursorIndex, useTimeStore } from '../time/hooks';
import { formatT } from '../time/markers';
import { Badge, NotComputed, Panel, STATUS_GLYPH, STATUS_VAR, STATUS_WORD, type Status } from '../ui';
import { NBSP, useUnits, type Units } from '../units';
import { convert as conv, ghostOf, ghostSeries as ghost, type GradedLimit, type RunData } from '../useRunData';
import { ChartPanel, Hint, NotYet, Readout, SideName, Table } from './kit';
import { SIDE_TOKEN, SIDE_VAR, useClockIndex, type SideKey } from './side';
import { anchorToVessel, coarseRungs, ladderView, rungsFromDiag, rungsFromNetwork, type LadderView } from './ladder';
import type { PageProps } from './Overview';

/**
 * Feed asks "Where does the pressure go?": the pressure ladder at the cursor (bottle to chamber,
 * element by element, LOX and fuel side by side), every pressure on one chart, the regulator's
 * operating point, the bottle and the gas it spends, the press solenoids, the saturation and
 * cavitation margins, the propellant, the surge when the mains open at Fire (they never shut) and
 * the tanks run out (gas at the outlet).
 */

const pctText = (u: Units, f: number | null) => (f === null ? '' : u.fmt({ value: f * 100, unit: '%', digits: 0 }));

// ------------------------------------------------------------------ the ladder

function LadderColumn({ side, view, u }: { side: 'ox' | 'fuel'; view: LadderView; u: Units }) {
  const color = SIDE_VAR[side];
  const p = (x: number | null) => u.fmt(u.p(x));
  const row = 'grid grid-cols-[minmax(6rem,9rem)_minmax(3rem,1fr)_5.5rem_3rem] items-center gap-x-3 py-[3px]';
  const name = 'truncate text-[12px] text-[var(--lx-text-2)]';
  const val = 'lx-num whitespace-nowrap text-right text-[12px]';
  return (
    <div className="min-w-0">
      <div className={`${row} border-b border-[var(--lx-line)] pb-1.5 text-[11px] text-[var(--lx-text-3)]`}>
        <span className="font-medium" style={{ color }}>{side === 'ox' ? 'LOX' : 'Fuel'}</span>
        <span />
        <span className="text-right">drop</span>
        <span className="text-right">share</span>
      </div>
      <div className={row}>
        <span className={`${name} text-[var(--lx-text-3)]`}>{view.start.label}</span>
        <span />
        {/* The bottle reads its gauge, as on every other page; the rest of the ladder is absolute. */}
        <span className={`${val} text-[var(--lx-text-2)]`}>{view.start.label === 'Bottle' ? u.fmt(u.p(view.start.p, 'gauge')) : p(view.start.p)}</span>
        <span />
      </div>
      {view.supply.map((r) => (
        <div key={r.key} className={row}>
          <Hint text={`${r.kind}: not to scale, ${u.fmt(u.dp(r.dp))} of supply above what the tanks need`} className={name}>{r.label}</Hint>
          <span aria-hidden className="h-0 border-t border-dashed" style={{ borderColor: 'var(--lx-gas)' }} />
          <span className={`${val} text-[var(--lx-text)]`}>{u.fmt(u.dp(r.dp))}</span>
          <span />
        </div>
      ))}
      {view.supply.length > 0 && (
        <div className={row}>
          <span className={`${name} text-[var(--lx-text-3)]`}>{view.top.label}</span>
          <span />
          <span className={`${val} text-[var(--lx-text-2)]`}>{p(view.top.p)}</span>
          <span />
        </div>
      )}
      {view.rungs.map((r) => {
        const gain = r.dp !== null && r.dp < 0;
        return (
          <div key={r.key} className={row}>
            <span className={name} title={`${r.label} (${r.kind})`}>{r.label}</span>
            <span aria-hidden className="relative h-2.5">
              <span className="absolute inset-y-[4px] left-0 right-0 bg-[var(--lx-line)]" />
              {r.dp !== null && (
                <span className="absolute inset-y-0 rounded-[2px]"
                      style={{ left: `${r.x0 * 100}%`, width: `max(2px, ${(r.x1 - r.x0) * 100}%)`, background: gain ? 'transparent' : color, border: gain ? `1px solid ${color}` : undefined }} />
              )}
            </span>
            <span className={`${val} text-[var(--lx-text)]`}>{u.fmt(u.dp(r.dp))}</span>
            <span className={`${val} text-[11px] text-[var(--lx-text-3)]`}>{pctText(u, r.share)}</span>
          </div>
        );
      })}
      <div className={`${row} border-t border-[var(--lx-line)] pt-1.5`}>
        <span className={`${name} text-[var(--lx-text)]`}>{view.end.label}</span>
        <span />
        <span className={`${val} text-[var(--lx-text)]`}>{p(view.end.p)}</span>
        <span />
      </div>
      <div className={row}>
        <span className={`${name} text-[var(--lx-text-3)]`}>{view.supply.length ? 'Outlet to chamber' : `${view.top.label} to chamber`}</span>
        <span />
        <span className={`${val} text-[var(--lx-text-2)]`}>{u.fmt(u.dp(view.span))}</span>
        <span className={`${val} text-[11px] text-[var(--lx-text-3)]`}>{view.span !== null ? '100\u00a0%' : ''}</span>
      </div>
    </div>
  );
}

function LadderPanel({ data, ladder }: { data: RunData; ladder: Diagnostics['ladder'] }) {
  const u = useUnits();
  const i = useCursorIndex();
  const k = useClockIndex(ladder?.t);
  const res = data.result;
  const net = useMemo(() => (ladder ? null : networkOf(res)), [ladder, res]);
  const kn = useClockIndex(net?.t);
  const pc = i >= 0 ? data.cols.pc[i] ?? null : null;
  const firing = i >= 0 && data.firing[i];
  const views = useMemo(() => {
    if (!firing) return null;
    return (['ox', 'fuel'] as const).map((side) => {
      const fromDiag = ladder ? rungsFromDiag(ladder, side, k) : null;
      const vessel = res.series.copv_psia[i] ?? null;
      if (fromDiag) {
        const node = fromDiag.total !== null && pc !== null ? pc + fromDiag.total : null;
        const a = anchorToVessel(fromDiag.rungs, node, vessel);
        return { side, view: ladderView(a.rungs, { label: 'Bottle', p: a.start }, { label: 'Chamber', p: pc }) };
      }
      const fromNet = net ? rungsFromNetwork(net, side, kn) : null;
      if (fromNet) {
        // The recorded paths start at the bottle (DATA-CONTRACT 2).
        const a = anchorToVessel(fromNet.rungs, fromNet.start, vessel);
        return { side, view: ladderView(a.rungs, { label: 'Bottle', p: a.start }, { label: 'Chamber', p: pc }) };
      }
      return { side, view: ladderView(coarseRungs(res, side, i, pc), { label: 'Lockup', p: res.summary[side].t0_psia }, { label: 'Chamber', p: pc }) };
    });
  }, [firing, ladder, k, i, pc, res, net, kn]);
  return (
    <Panel title="Pressure ladder" className="lg:col-span-12"
           right={<span className="lx-num">{i >= 0 ? `at ${formatT(data.t[i])}` : ''}{ladder || net?.paths?.ox?.length ? '' : ' · coarse: lockup to chamber'}</span>}>
      {views ? (
        <div className="grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2">
          {views.map(({ side, view }) => <LadderColumn key={side} side={side} view={view} u={u} />)}
        </div>
      ) : <NotComputed height={160}>No flow at the cursor</NotComputed>}
    </Panel>
  );
}

// ------------------------------------------------------------------ the regulator

function anyRange(t: readonly number[], flags: readonly (boolean | null)[] | undefined): [number, number] | null {
  if (!flags) return null;
  let a = -1;
  let b = -1;
  flags.forEach((f, k) => { if (f) { if (a < 0) a = k; b = k; } });
  return a >= 0 ? [t[a], t[b]] : null;
}

function RegulatorPanel({ data, reg, fallback }: { data: RunData; reg: RegulatorDiag; fallback: ChartSeries[] }) {
  const u = useUnits();
  const k = useClockIndex(reg.t);
  const md = u.scale('mdot');
  const series = useMemo<ChartSeries[]>(() => {
    const out: ChartSeries[] = [];
    const cap = colOf(reg.capacity_mdot, reg.t.length);
    const flow = colOf(reg.mdot, reg.t.length);
    if (cap) out.push({ key: 'reg_cap', label: 'Capacity', color: '--lx-text-3', dash: [4, 3], values: conv(cap, md.to) });
    if (flow) out.push({ key: 'reg_flow', label: 'Flow', color: '--lx-gas', values: conv(flow, md.to), width: 2 });
    return out;
  }, [reg, md]);
  const choked = anyRange(reg.t, reg.choked);
  const wide = anyRange(reg.t, reg.wide_open);
  const use = colAt(reg.use_frac, k);
  return (
    <Panel title={<Hint text="The regulator's flow against what it can pass at its inlet pressure. Wide open: it can no longer hold the tanks' pressure.">Regulator</Hint>}
           right={reg.cv !== null && reg.cv !== undefined ? <span className="lx-num">Cv{NBSP}{reg.cv}</span> : undefined} className="lg:col-span-5">
      <Readout items={[
        { label: 'Inlet', value: u.fmt(u.p(colAt(reg.inlet_psia, k))) },
        { label: 'Outlet', value: u.fmt(u.p(colAt(reg.outlet_psia, k))) },
        { label: 'Use', value: use === null ? '—' : u.fmt({ value: use * 100, unit: '%', digits: 0 }) },
        { label: 'Droop', value: u.fmt(u.dp(colAt(reg.droop_psi, k))) },
      ]} />
      <div className="mt-3 flex min-h-[20px] flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[var(--lx-text-2)]">
        {wide ? <Badge status="warn" size="sm">Wide open {formatT(wide[0])}</Badge> : <span className="text-[var(--lx-text-3)]">never wide open</span>}
        {choked && <span className="lx-num text-[var(--lx-text-3)]">choked {formatT(choked[0])} – {formatT(choked[1])}</span>}
      </div>
      {series.length
        ? <Chart t={reg.t} series={series} yUnit={md.unit} digits={md.digits} events={data.events} height={196} className="mt-2" />
        : fallback.length
          ? <Chart t={data.t} series={fallback} yUnit={u.scale('pressure').unit} events={data.events} height={196} className="mt-2" />
          : <NotComputed height={196} />}
    </Panel>
  );
}

// ------------------------------------------------------------------ the gas

function PressurantPanel({ pr }: { pr: PressurantDiag | undefined }) {
  const u = useUnits();
  if (!pr) return null;
  const loaded = pr.loaded_kg ?? null;
  const used = pr.used_kg ?? null;
  const left = pr.residual_kg ?? (loaded !== null && used !== null ? loaded - used : null);
  const need = pr.required_kg ?? null;
  const scale = Math.max(loaded ?? 0, need ?? 0, (used ?? 0) + (left ?? 0)) || 1;
  const w = (x: number | null) => `${Math.max(0, (x ?? 0) / scale) * 100}%`;
  return (
    <Panel title={<Hint text="The gas the bottle was filled with, what the burn spent pushing propellant, and what the burn needed at the least.">Pressurant budget</Hint>}
           right={pr.species ? <span>{pr.species}</span> : undefined} className="lg:col-span-4">
      <div className="relative mt-1 h-4 overflow-visible rounded-[3px] bg-[var(--lx-line)]" role="img"
           aria-label={`Used ${u.fmt(u.m(used))} of ${u.fmt(u.m(loaded))} loaded; ${u.fmt(u.m(left))} left${need !== null ? `; ${u.fmt(u.m(need))} needed` : ''}`}>
        <div className="absolute inset-y-0 left-0 rounded-l-[3px]" style={{ width: w(used), background: 'var(--lx-gas)' }} />
        <div className="absolute inset-y-0" style={{ left: w(used), width: w(left), background: 'color-mix(in srgb, var(--lx-gas) 30%, transparent)' }} />
        {need !== null && <div className="absolute -inset-y-1 w-[2px] bg-[var(--lx-text)]" style={{ left: w(need) }} />}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-[var(--lx-text-3)]">
        <span><span aria-hidden className="mr-1 inline-block h-2 w-2 rounded-[1px] align-middle" style={{ background: 'var(--lx-gas)' }} />used</span>
        <span><span aria-hidden className="mr-1 inline-block h-2 w-2 rounded-[1px] align-middle" style={{ background: 'color-mix(in srgb, var(--lx-gas) 30%, transparent)' }} />left</span>
        {need !== null && <span><span aria-hidden className="mr-1 inline-block h-2.5 w-[2px] align-middle bg-[var(--lx-text)]" />needed</span>}
      </div>
      <div className="mt-4">
        <Readout items={[
          { label: 'Loaded', value: u.fmt(u.m(loaded)) },
          { label: 'Used', value: u.fmt(u.m(used)) },
          { label: 'Left', value: u.fmt(u.m(left)) },
          { label: 'Needed', value: u.fmt(u.m(need)) },
          { label: 'Margin', value: u.fmt(u.m(pr.margin_kg ?? null)) },
        ]} />
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ solenoids, margins

function SolenoidsPanel({ data, sols }: { data: RunData; sols: SolenoidDiag[] }) {
  const u = useUnits();
  const i = useCursorIndex();
  const n = data.t.length;
  return (
    <Panel title={<Hint text="The drop across each press solenoid at the cursor, and its share of the regulator-to-tank drop.">Press solenoids</Hint>}
           right={<span className="lx-num">{i >= 0 ? `at ${formatT(data.t[i])}` : ''}</span>} className="lg:col-span-4">
      <Table caption="Press solenoids at the cursor" head={[{ sr: 'Solenoid' }, 'Drop', 'Share', { sr: 'Through the burn' }]} align={['l', 'r', 'r', 'r']}
             rows={sols.map((s) => {
               const dp = colOf(s.dp_psi, n);
               const share = colOf(s.share_of_reg_to_tank, n);
               return [
                 // Cv in the name's hover: the panel is a third of the page, and the drop is what moves.
                 <span key="n" className="whitespace-nowrap"><SideName side={s.side as SideKey}>
                   <Hint text={`Cv ${s.cv ?? '—'}${(s as { cv_provenance?: string }).cv_provenance ? ` (${(s as { cv_provenance?: string }).cv_provenance})` : ''}.`}>{s.label ?? s.id}</Hint>
                 </SideName></span>,
                 u.fmt(u.dp(colAt(dp, i))),
                 pctText(u, colAt(share, i)) || '—',
                 dp ? <span key="s" className="inline-block align-middle"><MiniSpark t={data.t} values={dp} color={SIDE_TOKEN[(s.side ?? "gas") as SideKey]} width={48} height={18} /></span> : '',
               ];
             })} />
    </Panel>
  );
}

function limitFor(limits: readonly GradedLimit[], ...needles: string[]): GradedLimit | undefined {
  return limits.find((l) => needles.some((x) => x && l.key.includes(x)));
}

function Glyph({ status }: { status: Status | null }) {
  if (!status) return <span aria-hidden className="inline-block w-3" />;
  return <span aria-label={STATUS_WORD[status]} className="inline-block w-3 text-center font-semibold" style={{ color: STATUS_VAR[status] }}>{STATUS_GLYPH[status]}</span>;
}

function MarginsPanel({ data, d, missing }: { data: RunData; d: Diagnostics; missing: string }) {
  const u = useUnits();
  const store = useTimeStore();
  const n = data.t.length;
  const jump = (t: number | null | undefined, key: string) => (t === null || t === undefined ? '—' : (
    <button key="t" type="button" className="lx-num cursor-pointer rounded-[4px] px-1 hover:bg-[var(--lx-surface-2)]"
            onClick={() => store.focus(t, key)} aria-label={`Put the cursor at ${formatT(t)}`}>{formatT(t)}</button>
  ));
  const rows: ReactNode[][] = [];
  for (const node of d.saturation?.nodes ?? []) {
    const m = colOf(node.margin_psi, n);
    const lim = limitFor(data.limits, node.id, `saturation_${node.label}`);
    rows.push([
      <span key="l" className="flex items-baseline gap-2 whitespace-nowrap"><Glyph status={lim?.status ?? null} /><SideName side={node.side as SideKey}>{node.label}</SideName></span>,
      u.fmt(u.dp(node.min_psi ?? null)),
      jump(node.t_min, `sat-${node.id}`),
      m ? <span key="s" className="inline-block align-middle"><MiniSpark t={data.t} values={m} color={SIDE_TOKEN[(node.side ?? 'gas') as SideKey]} width={72} height={18} band={{ lo: 0, hi: 0 }} /></span> : '',
    ]);
  }
  for (const side of ['ox', 'fuel'] as const) {
    const c: CavitationSide | undefined = d.cavitation?.[side];
    if (!c) continue;
    const K = colOf(c.K, n);
    const lim = limitFor(data.limits, `cavitation_${side}`, side === 'ox' ? 'cavitation_lox' : 'cavitation_fuel');
    const min = c.min_K ?? (K ? Math.min(...K.filter((x): x is number => x !== null)) : null);
    const incipient = typeof c.K_incipient === 'number' && Number.isFinite(c.K_incipient) ? fmt(c.K_incipient, 2) : null;
    rows.push([
      <span key="l" className="flex items-baseline gap-2 whitespace-nowrap"><Glyph status={lim?.status ?? null} />
        <Hint text={`The orifice's cavitation number K; it starts to cavitate below ${incipient ?? 'its incipient value'}${c.flip_risk ? '. Hydraulic flip is possible at this L/d' : ''}.`}>
          <SideName side={side}>{side === 'ox' ? 'LOX injector K' : 'Fuel injector K'}</SideName>
        </Hint>
        {c.flip_risk && <span className="text-[11px] text-[var(--lx-warn)]">flip risk</span>}
      </span>,
      min === null || !Number.isFinite(min) ? '—' : `${u.fmt(u.ratio(min))}${incipient ? ` (> ${incipient})` : ''}`,
      jump(c.t_min, `cav-${side}`),
      K ? <span key="s" className="inline-block align-middle"><MiniSpark t={data.t} values={K} color={SIDE_TOKEN[side]} width={72} height={18}
                                                                band={c.K_incipient ? { lo: c.K_incipient, hi: c.K_incipient } : null} /></span> : '',
    ]);
  }
  return (
    <Panel title={<Hint text="Each liquid node's pressure above the propellant's vapour pressure at the node's temperature (psi above boiling); below zero it boils. K: the injector orifice's cavitation number, (p_in − p_vap) / (p_in − p_c); below the incipient value the orifice starts to cavitate.">Boiling and cavitation</Hint>}
           right={<span>psi above boiling, lowest</span>} className="lg:col-span-6">
      {rows.length
        ? <Table caption="Saturation and cavitation margins" head={[{ sr: 'Node' }, 'Lowest', 'When', { sr: 'Through the burn' }]}
                 align={['l', 'r', 'r', 'r']} rows={rows} />
        : <NotComputed height={96}>{missing}</NotComputed>}
    </Panel>
  );
}

function WaterHammerPanel({ d, missing }: { d: Diagnostics; missing: string; limits: readonly GradedLimit[] }) {
  const u = useUnits();
  // The mains open for Fire and stay open (the team, 2026-10-03): only the opening surge is a case
  // the stand sees, so the closing surge the diagnostic also computes is not shown.
  const rows = (d.water_hammer ?? []).filter((w) => typeof w.opening?.peak_psia === 'number');
  return (
    <Panel title={<Hint text="The pressure spike in each main line when its valve opens at Fire and the liquid column first meets the injector. An upper bound: the gas still in the manifold, which cushions it, is left out.">Opening surge</Hint>}
           right={<span className="lx-num">at Fire</span>} className="lg:col-span-4">
      {rows.length ? (
        <Table caption="Opening surge on each main line" head={[{ sr: 'Line' }, 'Peak', 'Rating']}
               align={['l', 'r', 'r']}
               rows={rows.map((w) => [
                 <span key="l" className="whitespace-nowrap"><SideName side={w.side as SideKey}>{w.line}</SideName></span>,
                 u.fmt(u.p(w.opening?.peak_psia ?? null)),
                 u.fmt(u.p(w.rating_psia ?? null)),
               ])} />
      ) : <NotComputed height={72}>{missing}</NotComputed>}
    </Panel>
  );
}

function OutflowPanel({ d, missing }: { d: Diagnostics; missing: string }) {
  const u = useUnits();
  const rows = d.outflow ?? [];
  return (
    <Panel title={<Hint text="When the gas first reaches each tank's outlet as the liquid runs low (vortex or dip), and what is left in the tank then.">Tank outflow</Hint>}
           right={<span>as the tanks run low</span>} className="lg:col-span-4">
      {rows.length ? (
        <Table caption="Gas reaching each tank outlet" head={[{ sr: 'Tank' }, 'Gas at outlet', 'Left then', 'Outlet']} align={['l', 'r', 'r', 'r']}
               rows={rows.map((o) => [
                 <span key="n" title={o.tank}><SideName side={o.side as SideKey}>{o.side === 'ox' ? 'LOX tank' : o.side === 'fuel' ? 'Fuel tank' : o.tank}</SideName></span>,
                 o.ingestion_onset_s === null || o.ingestion_onset_s === undefined ? 'never' : formatT(o.ingestion_onset_s),
                 u.fmt(u.m(o.residual_kg ?? null)),
                 u.fmt(u.len(o.outlet_d_mm === null || o.outlet_d_mm === undefined ? null : o.outlet_d_mm / 1000)),
               ])} />
      ) : <NotComputed height={72}>{missing}</NotComputed>}
    </Panel>
  );
}

// ------------------------------------------------------------------ the charts

function useFeedCharts(data: RunData, vs: RunData | null, u: Units, d: Diagnostics) {
  return useMemo(() => {
    const pa = u.scale('pressure', { pressure: 'abs' });
    const pg = u.scale('pressure', { pressure: 'gauge', gaugeZeroPsia: data.gaugeZeroPsia });
    const pgVs = vs ? u.scale('pressure', { pressure: 'gauge', gaugeZeroPsia: vs.gaugeZeroPsia }) : pg;
    const m = u.scale('mass');
    const md = u.scale('mdot');
    const c = data.cols;
    const regs = Object.entries(data.result.series.regulators);
    const bottleT = colOf(d.pressurant?.bottle_T_K, data.t.length);
    return {
      units: { pa: pa.unit, pg: pg.unit, m: m.unit, md: md.unit },
      pressures: [
        ...ghost('lox_tank', data, vs, (r) => r.cols.tankO, pa.to),
        { key: 'lox_tank', label: 'LOX tank', color: '--lx-lox', values: conv(c.tankO, pa.to) },
        { key: 'lox_inj', label: 'LOX injector', color: '--lx-lox', dash: [4, 3], values: conv(c.injO, pa.to) },
        { key: 'fuel_tank', label: 'Fuel tank', color: '--lx-fuel', values: conv(c.tankF, pa.to) },
        { key: 'fuel_inj', label: 'Fuel injector', color: '--lx-fuel', dash: [4, 3], values: conv(c.injF, pa.to) },
        { key: 'pc', label: 'Chamber', color: '--lx-hot', values: conv(c.pc, pa.to) },
      ] as ChartSeries[],
      bottle: [
        ...(vs ? [{ key: 'bottle_vs', label: '', color: '', ghost: true, values: conv(ghostOf(data, vs, vs.cols.bottlePsia), pgVs.to) }] : []),
        { key: 'bottle', label: 'Bottle', color: '--lx-gas', values: conv(c.bottlePsia, pg.to) },
      ] as ChartSeries[],
      regulators: regs.map(([id, r], k) => ({ key: `reg_${id}`, label: r.label || id, color: '--lx-gas', dash: k ? [4, 3] : undefined, values: conv(r.outlet_psia, pa.to) })) as ChartSeries[],
      temps: [
        ...ghost('ullage_lox', data, vs, (r) => r.cols.ullageO, (x) => x),
        ...(bottleT ? [{ key: 'bottle_T', label: 'Bottle', color: '--lx-gas', values: bottleT }] : []),
        { key: 'ullage_lox', label: 'LOX ullage', color: '--lx-lox', values: c.ullageO },
        { key: 'ullage_fuel', label: 'Fuel ullage', color: '--lx-fuel', values: c.ullageF },
      ] as ChartSeries[],
      liquid: [
        ...ghost('liquid_lox', data, vs, (r) => r.cols.liquidO, m.to),
        { key: 'liquid_lox', label: 'LOX', color: '--lx-lox', values: conv(c.liquidO, m.to) },
        { key: 'liquid_fuel', label: 'Fuel', color: '--lx-fuel', values: conv(c.liquidF, m.to) },
      ] as ChartSeries[],
      flow: [
        ...ghost('mdot_lox', data, vs, (r) => r.cols.mdotO, md.to),
        { key: 'mdot_lox', label: 'LOX', color: '--lx-lox', values: conv(c.mdotO, md.to) },
        { key: 'mdot_fuel', label: 'Fuel', color: '--lx-fuel', values: conv(c.mdotF, md.to) },
      ] as ChartSeries[],
      digits: { p: pa.digits, m: m.digits, md: md.digits },
    };
  }, [data, vs, u, d.pressurant]);
}

export function Feed({ data, vs }: PageProps) {
  const u = useUnits();
  const d = useMemo(() => diag(data.result), [data.result]);
  const ch = useFeedCharts(data, vs, u, d);
  const ev = data.events;
  const pin0 = useMemo(() => [0, null] as const, []);
  const r = data.result;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      <LadderPanel data={data} ladder={d.ladder} />
      <ChartPanel title="Pressures" className="lg:col-span-7" t={data.t} series={ch.pressures} yUnit={ch.units.pa} height={300} events={ev} />
      {d.regulator
        ? <RegulatorPanel data={data} reg={d.regulator} fallback={ch.regulators} />
        : <ChartPanel title="Regulator outlet" className="lg:col-span-5" t={data.t} series={ch.regulators} yUnit={ch.units.pa} height={300} events={ev}
                      empty={!ch.regulators.length} />}
      <ChartPanel title="Bottle" className="lg:col-span-4" t={data.t} series={ch.bottle} yUnit={ch.units.pg} height={220} events={ev} />
      <ChartPanel title="Gas temperatures" className={d.pressurant ? 'lg:col-span-4' : 'lg:col-span-8'} t={data.t} series={ch.temps} yUnit="K" height={220} events={ev} digits={1} />
      <PressurantPanel pr={d.pressurant} />
      {(d.saturation || d.cavitation || diagFailed(r, 'saturation') || diagFailed(r, 'cavitation'))
        && <MarginsPanel data={data} d={d} missing={diagMissing(r, d.saturation ? 'cavitation' : 'saturation')} />}
      <div className={`flex min-w-0 flex-col gap-6 ${d.saturation || d.cavitation || diagFailed(r, 'saturation') || diagFailed(r, 'cavitation') ? 'lg:col-span-6' : 'lg:col-span-12'}`}>
        <ChartPanel title="Propellant in the tanks" t={data.t} series={ch.liquid} yUnit={ch.units.m} height={220} events={ev}
                    yPin={pin0} digits={ch.digits.m} />
        <ChartPanel title="Propellant flow" t={data.t} series={ch.flow} yUnit={ch.units.md} height={220} events={ev}
                    digits={ch.digits.md} />
      </div>
      {d.solenoids
        ? <SolenoidsPanel data={data} sols={d.solenoids} />
        : diagFailed(r, 'solenoids') && <Panel title="Press solenoids" className="lg:col-span-4"><NotComputed height={96}>{diagMissing(r, 'solenoids')}</NotComputed></Panel>}
      {(d.water_hammer || diagFailed(r, 'water_hammer')) && <WaterHammerPanel d={d} missing={diagMissing(r, 'water_hammer')} limits={data.limits} />}
      {(d.outflow || diagFailed(r, 'outflow')) && <OutflowPanel d={d} missing={diagMissing(r, 'outflow')} />}
      <NotYet items={[
        !d.solenoids && !diagFailed(r, 'solenoids') && 'press solenoids',
        !d.saturation && !d.cavitation && !diagFailed(r, 'saturation') && !diagFailed(r, 'cavitation') && 'boiling and cavitation',
        !d.pressurant && !diagFailed(r, 'pressurant') && 'pressurant budget',
        !d.water_hammer && !diagFailed(r, 'water_hammer') && 'water hammer',
        !d.outflow && !diagFailed(r, 'outflow') && 'tank outflow',
      ].filter((x): x is string => !!x)} />
    </div>
  );
}
