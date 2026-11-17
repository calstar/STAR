'use client'

/**
 * ASI Twin: Hotbench Engine and Hotbench Twin cut down to the igniter.
 *
 *   Engine    the torch at a design point (Pc, O/F, Tc, c*, energy margin), sizing
 *             holes and throat for a target, Tc / c* across O/F.
 *   Sequence  a light sequence run through the twin: valve strokes, line volumes,
 *             reliefs, ignition, the light gate, tail-off, copper and TC-1.
 *   Live      the twin driven by the stand: commanded valves (and spark), measured
 *             upstream PTs; predicted against measured downstream PTs and TC-1.
 *   Model     the hardware description both run on.
 *
 * Everything here is computed in the browser (lib/asi). Nothing is sent to the
 * stand: "Live" only reads.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import AsiSchematic from '@/components/asi/AsiSchematic';
import AsiModelEditor, { AsiChart } from '@/components/asi/AsiModelEditor';
import { ASI_COLORS, NumField, Panel, Stat, SubTabs, fmt, useAsiHardware } from '@/components/asi/AsiParts';
import { useActuatorCommandedState, useSensorValue } from '@/lib/store';
import { ActuatorState } from '@/lib/types';
import { useAsiSettings } from '@/lib/asi/settings';
import { ENERGY, ofSweep, operatingPoint, sizeAsi, type SizingInput } from '@/lib/asi/engine';
import {
  AsiTwin, SEQ_ACTIONS, defaultSequence, failedIgnitionSequence, simulate, ventSequence, type RunResult, type SeqAction, type SeqEvent, type TwinSample,
} from '@/lib/asi/twin';
import { OF_FLAMMABLE, OF_STOICH, PA_PER_PSI, P_ATM } from '@/lib/asi/physics';
import { CEA_SOURCE } from '@/lib/asi/cea-gox-ch4';

type Tab = 'engine' | 'sequence' | 'live' | 'model';
const TABS: { id: Tab; label: string }[] = [
  { id: 'engine', label: 'Engine' },
  { id: 'sequence', label: 'Twin · sequence' },
  { id: 'live', label: 'Twin · live' },
  { id: 'model', label: 'Model' },
];

// ── Engine ───────────────────────────────────────────────────────────────────

function EngineTab() {
  const { settings, setModel } = useAsiSettings();
  const m = settings.model;
  const [goxP, setGoxP] = useState(m.gox.supplyPsig);
  const [ch4P, setCh4P] = useState(m.ch4.supplyPsig);
  const op = useMemo(() => operatingPoint(m, goxP, ch4P), [m, goxP, ch4P]);

  const [sz, setSz] = useState<SizingInput>({
    pcPsia: 100, of: 2.5, mdotTotal_gs: 17.5, cstarEff: m.cstarEff, goxHolePsia: 595, ch4HolePsia: 618, cd: m.gox.holeCd,
  });
  const sized = useMemo(() => sizeAsi(sz), [sz]);
  const setS = <K extends keyof SizingInput>(k: K, v: number) => setSz((s) => ({ ...s, [k]: v }));
  const apply = (drills: boolean) => setModel({
    ...m,
    cstarEff: sz.cstarEff,
    throatDia_mm: Number((drills ? sized.throatDrill.dia_mm : sized.throatDia_mm).toFixed(3)),
    gox: { ...m.gox, holeCd: sz.cd, holeDia_mm: Number((drills ? sized.goxDrill.dia_mm : sized.goxHoleDia_mm).toFixed(3)) },
    ch4: { ...m.ch4, holeCd: sz.cd, holeDia_mm: Number((drills ? sized.ch4Drill.dia_mm : sized.ch4HoleDia_mm).toFixed(3)) },
  });

  const sweep = useMemo(() => ofSweep(op.pcPsia || 100, m.cstarEff), [op.pcPsia, m.cstarEff]);

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      <Panel title="Operating point · current hardware">
        <p className="mb-2 font-mono text-[11px] text-ink-3">
          Hole Ø{m.gox.holeDia_mm} / Ø{m.ch4.holeDia_mm} mm (Cd {m.gox.holeCd}), throat Ø{m.throatDia_mm} mm, η<sub>c*</sub> {m.cstarEff},
          exhausting to {m.backPressurePsia} psia. Burning, at these pressures at the holes:
        </p>
        <div className="grid max-w-md grid-cols-1">
          <NumField label="GOx at hole" unit="psig" value={goxP} onChange={setGoxP} />
          <NumField label="CH4 at hole" unit="psig" value={ch4P} onChange={setCh4P} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Pc" value={fmt(op.pcPsia, 1)} unit="psia" color={ASI_COLORS.pc} />
          <Stat label="O/F" value={fmt(op.of, 2)} color={ASI_COLORS.of} />
          <Stat label="ṁ GOx" value={fmt(op.mdotOx_gs, 2)} unit="g/s" color={ASI_COLORS.gox} />
          <Stat label="ṁ CH4" value={fmt(op.mdotF_gs, 2)} unit="g/s" color={ASI_COLORS.ch4} />
          <Stat label="Tc (ideal)" value={fmt(op.tcK, 0)} unit="K" />
          <Stat label="c* (ideal)" value={fmt(op.cstarIdeal, 0)} unit="m/s" />
          <Stat label="Energy margin" value={fmt(op.energyMargin, 2)} color={op.energyMargin >= ENERGY.target ? '#4ade80' : '#e5b53a'}
            hint={`ṁ × ${ENERGY.deliverableMJperKg} MJ/kg × η² / ${ENERGY.requiredKW} kW (design point, O/F 2.5); target ${ENERGY.target}`} />
          <Stat label="Holes" value={`${op.goxHoleChoked ? 'choked' : 'UNCHOKED'} / ${op.ch4HoleChoked ? 'choked' : 'UNCHOKED'}`}
            color={op.goxHoleChoked && op.ch4HoleChoked ? '#4ade80' : '#e5b53a'} />
        </div>
        <div className="mt-3">
          <AsiChart
            data={sweep}
            x="of"
            xLabel="O/F"
            series={[
              { key: 'cstar', name: 'c* ideal (m/s)', color: ASI_COLORS.pc },
              { key: 'cstarEff', name: `c* × ${m.cstarEff}`, color: ASI_COLORS.pc, dashed: true },
              { key: 'tcK', name: 'Tc (K)', color: ASI_COLORS.tc, yAxis: 'right' },
            ]}
            yLabel="c* m/s"
            yRightLabel="Tc K"
            refX={[
              ...(Number.isFinite(op.of) ? [{ x: Number(op.of.toFixed(2)), label: 'now', color: ASI_COLORS.of }] : []),
              { x: Number(OF_STOICH.toFixed(2)), label: 'stoich' },
            ]}
            refBand={{ x1: sweep[0].of, x2: Number(OF_FLAMMABLE.min.toFixed(2)), label: 'won’t light' }}
            height={240}
          />
          <p className="font-mono text-[10px] text-ink-4">{CEA_SOURCE}. Pc {fmt(op.pcPsia, 0)} psia.</p>
        </div>
      </Panel>

      <Panel title="Size an ASI">
        <div className="grid grid-cols-1 gap-x-6 md:grid-cols-2">
          <div>
            <NumField label="Chamber pressure" unit="psia" value={sz.pcPsia} onChange={(v) => setS('pcPsia', v)} note="Design point 100 psia (band 80–110)" />
            <NumField label="O/F" value={sz.of} onChange={(v) => setS('of', v)} note="Design point 2.5" />
            <NumField label="Total ṁ" unit="g/s" value={sz.mdotTotal_gs} onChange={(v) => setS('mdotTotal_gs', v)} note="Design point 17.5 g/s; 70 % insert 12.5" />
            <NumField label="η c*" value={sz.cstarEff} onChange={(v) => setS('cstarEff', v)} />
          </div>
          <div>
            <NumField label="GOx at hole" unit="psia" value={sz.goxHolePsia} onChange={(v) => setS('goxHolePsia', v)} note="Design point 595 psia" />
            <NumField label="CH4 at hole" unit="psia" value={sz.ch4HolePsia} onChange={(v) => setS('ch4HolePsia', v)} note="Design point 618 psia" />
            <NumField label="Hole Cd" value={sz.cd} onChange={(v) => setS('cd', v)} />
          </div>
        </div>
        <table className="mt-3 w-full font-mono text-[12px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.14em] text-ink-3">
              <th className="py-1">Part</th><th>Exact</th><th>Nearest drill</th><th>Flow</th>
            </tr>
          </thead>
          <tbody className="text-ink">
            <tr className="border-t border-line"><td className="py-1">Throat</td><td>Ø{fmt(sized.throatDia_mm, 3)} mm</td><td>{sized.throatDrill.name} (Ø{sized.throatDrill.dia_mm})</td><td>{fmt(sz.mdotTotal_gs, 1)} g/s</td></tr>
            <tr className="border-t border-line"><td className="py-1" style={{ color: ASI_COLORS.gox }}>GOx hole</td><td>Ø{fmt(sized.goxHoleDia_mm, 3)} mm</td><td>{sized.goxDrill.name} (Ø{sized.goxDrill.dia_mm})</td><td>{fmt(sized.mdotOx_gs, 2)} g/s</td></tr>
            <tr className="border-t border-line"><td className="py-1" style={{ color: ASI_COLORS.ch4 }}>CH4 hole</td><td>Ø{fmt(sized.ch4HoleDia_mm, 3)} mm</td><td>{sized.ch4Drill.name} (Ø{sized.ch4Drill.dia_mm})</td><td>{fmt(sized.mdotF_gs, 2)} g/s</td></tr>
          </tbody>
        </table>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Tc ideal" value={fmt(sized.tcK, 0)} unit="K" />
          <Stat label="c* ideal" value={fmt(sized.cstarIdeal, 0)} unit="m/s" />
          <Stat label="Choke margin GOx" value={fmt(sized.goxChokeMargin, 2)} unit="×" color={sized.goxChokeMargin >= 1 ? '#4ade80' : '#f87171'} hint="(P0/Pc) / critical ratio; ≥1 stays choked" />
          <Stat label="Energy margin" value={fmt(sized.energyMargin, 2)} color={sized.energyMargin >= ENERGY.target ? '#4ade80' : '#e5b53a'} />
        </div>
        {sized.warnings.length > 0 && (
          <ul className="mt-2 list-disc pl-4 font-mono text-[11px] text-amber-400">
            {sized.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="ctl px-3 py-1 text-[11px]" onClick={() => apply(true)}>Apply drills to model</button>
          <button type="button" className="ctl px-3 py-1 text-[11px]" onClick={() => apply(false)}>Apply exact sizes</button>
        </div>
        <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink-4">
          Pc = ṁ·η·c*/A<sub>t</sub>; holes from the orifice equation at P0 against Pc. Check: 17.5 g/s, O/F 2.5, 100 psia,
          η 0.90 at 595/618 psia gives the design point&apos;s #54 / #59 / L drill.
        </p>
      </Panel>
    </div>
  );
}

// ── Sequence ─────────────────────────────────────────────────────────────────

const ACTION_LABEL: Record<SeqAction, string> = {
  SPARK_ON: 'Spark on', SPARK_OFF: 'Spark off', GOX_OPEN: 'GOx valve open', GOX_CLOSE: 'GOx valve close',
  CH4_OPEN: 'CH4 valve open', CH4_CLOSE: 'CH4 valve close',
  GOX_VENT_UP_OPEN: 'GOx vent before valve open', GOX_VENT_UP_CLOSE: 'GOx vent before valve close',
  GOX_VENT_DN_OPEN: 'GOx vent after valve open', GOX_VENT_DN_CLOSE: 'GOx vent after valve close',
  CH4_VENT_UP_OPEN: 'CH4 vent before valve open', CH4_VENT_UP_CLOSE: 'CH4 vent before valve close',
  CH4_VENT_DN_OPEN: 'CH4 vent after valve open', CH4_VENT_DN_CLOSE: 'CH4 vent after valve close',
};

function thin(samples: TwinSample[], max = 700): TwinSample[] {
  if (samples.length <= max) return samples;
  const every = Math.ceil(samples.length / max);
  return samples.filter((_, i) => i % every === 0 || i === samples.length - 1);
}

function SequenceTab() {
  const { settings } = useAsiSettings();
  const m = settings.model;
  const [events, setEvents] = useState<SeqEvent[]>(() => defaultSequence(m));
  const [duration, setDuration] = useState(1.6);
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [scrub, setScrub] = useState(0);

  const run = () => {
    setBusy(true);
    // Let the button repaint before the (≈0.5 s) solve.
    window.setTimeout(() => {
      const r = simulate(m, events, duration);
      setResult(r);
      setScrub(Math.min(r.samples.length - 1, Math.round(r.samples.length * 0.4)));
      setBusy(false);
    }, 20);
  };

  const sorted = [...events].map((e, i) => ({ ...e, i })).sort((a, b) => a.t - b.t);
  const data = useMemo(() => (result ? thin(result.samples).map((s) => ({
    ...s,
    of: Number.isFinite(s.of) && s.mdotF_gs > 0.05 ? Math.min(s.of, 10) : null,
    neckC: s.neckK - 273.15,
  })) : []), [result]);
  const at = result ? result.samples[Math.min(scrub, result.samples.length - 1)] : null;
  const sum = result?.summary;
  const evMarks = [...new Set(events.map((e) => e.t))].map((t) => ({
    x: t, label: events.filter((e) => e.t === t).map((e) => ACTION_LABEL[e.action].replace(' valve', '')).join(', '),
  }));

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Panel title="Sequence" className="xl:col-span-1">
          <div className="flex flex-col gap-1">
            {sorted.map((e) => (
              <div key={e.i} className="flex items-center gap-2">
                <input type="number" step="0.01" value={e.t}
                  onChange={(ev) => { const v = parseFloat(ev.target.value); if (Number.isFinite(v)) setEvents((xs) => xs.map((x, j) => (j === e.i ? { ...x, t: Math.max(0, v) } : x))); }}
                  className="w-20 border border-line-strong bg-black px-1.5 py-0.5 text-right font-mono text-[12px] text-ink" />
                <span className="font-mono text-[10px] text-ink-3">s</span>
                <select value={e.action} onChange={(ev) => setEvents((xs) => xs.map((x, j) => (j === e.i ? { ...x, action: ev.target.value as SeqAction } : x)))}
                  className="flex-1 border border-line-strong bg-black px-1 py-0.5 font-mono text-[12px] text-ink">
                  {SEQ_ACTIONS.map((a) => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}
                </select>
                <button type="button" aria-label="Remove step" className="ctl h-6 w-6 text-[11px]" onClick={() => setEvents((xs) => xs.filter((_, j) => j !== e.i))}>×</button>
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="ctl px-2 py-1 text-[10px]" onClick={() => setEvents((xs) => [...xs, { t: Math.max(0, ...xs.map((x) => x.t)), action: 'SPARK_OFF' }])}>+ step</button>
            <button type="button" className="ctl px-2 py-1 text-[10px]" onClick={() => { setEvents(defaultSequence(m)); setDuration(m.burnCapS + 0.75); }}>Nominal light</button>
            <button type="button" className="ctl px-2 py-1 text-[10px]" onClick={() => { setEvents(failedIgnitionSequence()); setDuration(2.2); }}>Failed ignition</button>
            <button type="button" className="ctl px-2 py-1 text-[10px]" onClick={() => { setEvents(ventSequence()); setDuration(2.0); }}>Vent (safe)</button>
          </div>
          <div className="mt-2 max-w-xs">
            <NumField label="Run for" unit="s" value={duration} onChange={(v) => setDuration(Math.min(10, Math.max(0.05, v)))} />
          </div>
          <button type="button" className="ctl mt-2 w-full py-1.5 text-[12px]" disabled={busy} onClick={run}>{busy ? 'Running…' : 'Run twin'}</button>
          <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink-4">
            Starts with the regulators at setting and the downstream lines vented. &quot;Nominal light&quot; is the design point&apos;s
            step 1 (spark and both valves together) closed at the {m.burnCapS} s cap; &quot;Failed ignition&quot; is its no-light path
            (CH4 off, GOx flush, GOx off).
          </p>
        </Panel>

        <Panel title="Result" className="xl:col-span-2">
          {!sum ? (
            <p className="font-mono text-[11px] text-ink-4">Run the twin to see the light.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <Stat label="Light" value={sum.lightS === null ? 'none' : `${(sum.lightS * 1000).toFixed(0)} ms`} color={sum.lightS === null ? '#f87171' : '#4ade80'} />
                <Stat label={`Gate ${m.gatePcPsia} psia / ${m.gateMs} ms`} value={sum.gate.pass ? 'PASS' : 'FAIL'} color={sum.gate.pass ? '#4ade80' : '#f87171'} hint={`Peak Pc in the window ${sum.gate.pcAtGatePsia.toFixed(0)} psia`} />
                <Stat label="Steady Pc" value={fmt(sum.steady?.pcPsia, 1)} unit="psia" color={ASI_COLORS.pc} />
                <Stat label="Steady O/F" value={fmt(sum.steady?.of, 2)} color={ASI_COLORS.of} />
                <Stat label="ṁ GOx / CH4" value={sum.steady ? `${sum.steady.mdotOx_gs.toFixed(1)} / ${sum.steady.mdotF_gs.toFixed(1)}` : '—'} unit="g/s" />
                <Stat label="Burn (tail)" value={`${sum.burnS.toFixed(2)} (${sum.tailS.toFixed(2)})`} unit="s" />
                <Stat label="TC-1 peak" value={fmt(sum.tcPeakC, 0)} unit="°C" color={ASI_COLORS.tc} hint={`Bore surface peak ${sum.borePeakC.toFixed(0)} °C`} />
                <Stat label="Neck peak" value={fmt(sum.neckPeakK, 0)} unit="K" color={sum.neckPeakK >= m.thermal.neckLimitK ? '#f87171' : ASI_COLORS.neck} hint={`Limit ${m.thermal.neckLimitK} K`} />
              </div>
              {sum.warnings.length > 0 ? (
                <ul className="mt-2 list-disc pl-4 font-mono text-[11px] text-amber-400">
                  {sum.warnings.map((w) => <li key={w}>{w}</li>)}
                </ul>
              ) : (
                <p className="mt-2 font-mono text-[11px] text-green-400">No warnings.</p>
              )}
            </>
          )}
        </Panel>
      </div>

      {result && at && (
        <>
          <Panel title={`State at t = ${at.t.toFixed(3)} s`}>
            <input type="range" min={0} max={result.samples.length - 1} value={scrub} onChange={(e) => setScrub(Number(e.target.value))} className="w-full" aria-label="Time" />
            <AsiSchematic
              model={m}
              gox={{ upPsig: at.goxUpPsig, dnPsig: at.goxDnPsig, valve: at.goxPos, vents: at.goxVentPos }}
              ch4={{ upPsig: at.ch4UpPsig, dnPsig: at.ch4DnPsig, valve: at.ch4Pos, vents: at.ch4VentPos }}
              pcPsia={at.pcPsia} of={Number.isFinite(at.of) ? at.of : null} lit={at.lit} tcC={at.tcC}
              caption={`SIM t=${at.t.toFixed(3)} s`}
            />
          </Panel>
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <Panel title="Pressures">
              <AsiChart data={data} x="t" xLabel="s" yLabel="psig / psia" refX={evMarks} series={[
                { key: 'goxUpPsig', name: 'GOx up', color: ASI_COLORS.gox, dashed: true },
                { key: 'goxDnPsig', name: 'GOx dn', color: ASI_COLORS.gox },
                { key: 'ch4UpPsig', name: 'CH4 up', color: ASI_COLORS.ch4, dashed: true },
                { key: 'ch4DnPsig', name: 'CH4 dn', color: ASI_COLORS.ch4 },
                { key: 'pcPsia', name: 'Pc (psia)', color: ASI_COLORS.pc },
              ]} />
            </Panel>
            <Panel title="Flow & mixture">
              <AsiChart data={data} x="t" xLabel="s" yLabel="g/s" yRightLabel="O/F" series={[
                { key: 'mdotOx_gs', name: 'ṁ GOx', color: ASI_COLORS.gox },
                { key: 'mdotF_gs', name: 'ṁ CH4', color: ASI_COLORS.ch4 },
                { key: 'goxReliefGs', name: 'GOx reliefs', color: ASI_COLORS.gox, dashed: true },
                { key: 'ch4ReliefGs', name: 'CH4 reliefs', color: ASI_COLORS.ch4, dashed: true },
                { key: 'goxVentGs', name: 'GOx vents', color: '#7DD3FC', dashed: true },
                { key: 'ch4VentGs', name: 'CH4 vents', color: '#C4B5FD', dashed: true },
                { key: 'of', name: 'O/F', color: ASI_COLORS.of, yAxis: 'right' },
              ]} />
            </Panel>
            <Panel title="Copper & TC-1" className="xl:col-span-2">
              <AsiChart data={data} x="t" xLabel="s" yLabel="°C" series={[
                { key: 'tcC', name: 'TC-1 (reading)', color: ASI_COLORS.tc },
                { key: 'boreC', name: 'Bore surface at TC', color: ASI_COLORS.bore, dashed: true },
                { key: 'neckC', name: 'Lower neck', color: ASI_COLORS.neck },
              ]} />
              <p className="font-mono text-[10px] text-ink-4">
                TC-1 sits {m.thermal.tcDepth_mm} mm into the copper: it shows the body warming, tens of degrees per light, not the
                ~{Math.round(m.cstarEff ** 2 * 3100)} K gas. The lower neck (design point&apos;s lumped wall) is the burn-time limit at {m.thermal.neckLimitK} K.
              </p>
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

// ── Live ─────────────────────────────────────────────────────────────────────

function LiveTab() {
  const { settings } = useAsiSettings();
  const m = settings.model;
  const hw = useAsiHardware();
  const goxUp = useSensorValue(hw.entities.goxUp, 'pressure_psi');
  const goxDn = useSensorValue(hw.entities.goxDn, 'pressure_psi');
  const ch4Up = useSensorValue(hw.entities.ch4Up, 'pressure_psi');
  const ch4Dn = useSensorValue(hw.entities.ch4Dn, 'pressure_psi');
  const tc = useSensorValue(hw.entities.tc, 'temperature_c');
  const goxAct = hw.actuator(hw.mapping.goxValve);
  const ch4Act = hw.actuator(hw.mapping.ch4Valve);
  const sparkAct = hw.actuator(hw.mapping.spark);
  const goxCmd = useActuatorCommandedState(goxAct?.entity ?? '');
  const ch4Cmd = useActuatorCommandedState(ch4Act?.entity ?? '');
  const sparkCmd = useActuatorCommandedState(sparkAct?.entity ?? '');
  const gvu = useActuatorCommandedState(hw.actuator(hw.mapping.goxVentUp)?.entity ?? '');
  const gvd = useActuatorCommandedState(hw.actuator(hw.mapping.goxVentDn)?.entity ?? '');
  const cvu = useActuatorCommandedState(hw.actuator(hw.mapping.ch4VentUp)?.entity ?? '');
  const cvd = useActuatorCommandedState(hw.actuator(hw.mapping.ch4VentDn)?.entity ?? '');

  const [running, setRunning] = useState(false);
  const [useMeasuredUp, setUseMeasuredUp] = useState(true);
  const [manualSpark, setManualSpark] = useState(false);
  const [snap, setSnap] = useState<TwinSample | null>(null);
  const twinRef = useRef<AsiTwin | null>(null);
  const inputs = useRef({ goxUp, ch4Up, goxCmd, ch4Cmd, sparkCmd, useMeasuredUp, manualSpark, gvu, gvd, cvu, cvd });
  inputs.current = { goxUp, ch4Up, goxCmd, ch4Cmd, sparkCmd, useMeasuredUp, manualSpark, gvu, gvd, cvu, cvd };

  useEffect(() => {
    if (!running) return;
    twinRef.current = new AsiTwin(m);
    let last = performance.now();
    const id = window.setInterval(() => {
      const tw = twinRef.current;
      if (!tw) return;
      const now = performance.now();
      const dt = Math.min(0.2, (now - last) / 1000);
      last = now;
      const i = inputs.current;
      const pa = (psig: number | null) => (i.useMeasuredUp && psig !== null ? psig * PA_PER_PSI + P_ATM : null);
      tw.advance(dt, {
        goxOpen: i.goxCmd === ActuatorState.OPEN,
        ch4Open: i.ch4Cmd === ActuatorState.OPEN,
        spark: sparkAct ? i.sparkCmd === ActuatorState.OPEN : i.manualSpark,
        goxUpPa: pa(i.goxUp),
        ch4UpPa: pa(i.ch4Up),
        goxVents: [i.gvu === ActuatorState.OPEN, i.gvd === ActuatorState.OPEN],
        ch4Vents: [i.cvu === ActuatorState.OPEN, i.cvd === ActuatorState.OPEN],
      });
      setSnap(tw.sample());
    }, 50);
    return () => window.clearInterval(id);
  }, [running, m, sparkAct]);

  const row = (label: string, pred: number | null | undefined, meas: number | null, unit: string, color: string) => {
    const resid = pred != null && meas !== null ? meas - pred : null;
    return (
      <tr className="border-t border-line">
        <td className="py-1" style={{ color }}>{label}</td>
        <td className="text-right tabular-nums">{fmt(pred, 1)}</td>
        <td className="text-right tabular-nums">{fmt(meas, 1)}</td>
        <td className={`text-right tabular-nums ${resid !== null && Math.abs(resid) > 25 ? 'text-amber-400' : 'text-ink-2'}`}>{resid === null ? '—' : `${resid >= 0 ? '+' : ''}${resid.toFixed(1)}`}</td>
        <td className="pl-2 text-ink-3">{unit}</td>
      </tr>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <Panel title="Drive the twin from the stand" right={
        <button type="button" className="ctl px-3 py-1 text-[11px]" onClick={() => setRunning((r) => !r)}>{running ? 'Stop' : 'Start'}</button>
      }>
        <p className="mb-2 max-w-3xl font-mono text-[11px] leading-relaxed text-ink-3">
          Run valves and vents follow their commanded state on the stand ({goxAct?.name ?? 'GOx valve unmapped'}, {ch4Act?.name ?? 'CH4 valve unmapped'});
          the spark follows {sparkAct ? sparkAct.name : 'the toggle below (no spark actuator mapped)'}. The twin predicts the
          downstream PTs and TC-1; the residuals show where the model and the hardware part ways. Read-only: nothing is sent to the stand.
        </p>
        <div className="flex flex-wrap items-center gap-4 font-mono text-[11px] text-ink-2">
          <label className="flex items-center gap-2"><input type="checkbox" checked={useMeasuredUp} onChange={(e) => setUseMeasuredUp(e.target.checked)} />Upstream nodes from measured PTs</label>
          {!sparkAct && <label className="flex items-center gap-2"><input type="checkbox" checked={manualSpark} onChange={(e) => setManualSpark(e.target.checked)} />Spark on</label>}
          <span className="text-ink-3">{running ? `running · t = ${snap?.t.toFixed(1) ?? '0.0'} s` : 'stopped'}</span>
        </div>
      </Panel>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Panel title="Predicted vs measured">
          <table className="w-full font-mono text-[12px] text-ink">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.14em] text-ink-3"><th className="text-left">Channel</th><th className="text-right">Twin</th><th className="text-right">Stand</th><th className="text-right">Stand − twin</th><th /></tr>
            </thead>
            <tbody>
              {row(`GOx up ${m.gox.tags.upstreamPt}`, snap?.goxUpPsig, goxUp, 'psig', ASI_COLORS.gox)}
              {row(`GOx dn ${m.gox.tags.downstreamPt}`, snap?.goxDnPsig, goxDn, 'psig', ASI_COLORS.gox)}
              {row(`CH4 up ${m.ch4.tags.upstreamPt}`, snap?.ch4UpPsig, ch4Up, 'psig', ASI_COLORS.ch4)}
              {row(`CH4 dn ${m.ch4.tags.downstreamPt}`, snap?.ch4DnPsig, ch4Dn, 'psig', ASI_COLORS.ch4)}
              {row('TC-1', snap?.tcC, tc, '°C', ASI_COLORS.tc)}
            </tbody>
          </table>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Pc (twin)" value={fmt(snap?.pcPsia, 0)} unit="psia" color={ASI_COLORS.pc} />
            <Stat label="O/F (twin)" value={fmt(snap && Number.isFinite(snap.of) ? snap.of : null, 2)} color={ASI_COLORS.of} />
            <Stat label="Lit (twin)" value={snap ? (snap.lit ? 'YES' : 'no') : '—'} color={snap?.lit ? ASI_COLORS.pc : undefined} />
            <Stat label="Neck (twin)" value={fmt(snap?.neckK, 0)} unit="K" color={ASI_COLORS.neck} />
          </div>
        </Panel>
        <Panel title="Twin state">
          <AsiSchematic
            model={m}
            gox={{ upPsig: snap?.goxUpPsig ?? null, dnPsig: snap?.goxDnPsig ?? null, valve: snap?.goxPos ?? null, vents: snap?.goxVentPos }}
            ch4={{ upPsig: snap?.ch4UpPsig ?? null, dnPsig: snap?.ch4DnPsig ?? null, valve: snap?.ch4Pos ?? null, vents: snap?.ch4VentPos }}
            pcPsia={snap?.pcPsia} of={snap && Number.isFinite(snap.of) ? snap.of : null} lit={snap?.lit ?? null} tcC={snap?.tcC}
            caption={running ? 'TWIN · LIVE INPUTS' : 'TWIN · STOPPED'}
          />
        </Panel>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AsiTwinPage() {
  const [tab, setTab] = useState<Tab>('engine');
  return (
    <main className="flex h-full flex-col gap-3 overflow-auto bg-background px-4 py-4 text-text sm:px-8">
      <div className="flex flex-wrap items-center gap-3">
        <div className="h-2 w-2 flex-shrink-0" style={{ backgroundColor: ASI_COLORS.pc }} />
        <h1 className="font-mono text-[15px] font-semibold uppercase tracking-[0.32em] text-ink">ASI Twin</h1>
        <span className="font-mono text-[11px] text-ink-3">Hotbench Engine + Twin for the GOx / CH4 igniter</span>
      </div>
      <SubTabs<Tab> tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'engine' && <EngineTab />}
      {tab === 'sequence' && <SequenceTab />}
      {tab === 'live' && <LiveTab />}
      {tab === 'model' && <AsiModelEditor />}
    </main>
  );
}
