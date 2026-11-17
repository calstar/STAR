'use client'

/**
 * ASI system test: the igniter's two gas lines and its thermocouple on the stand.
 *
 * Per line (P&ID ASI V1): two PTs (regulator outlet, run-valve outlet), one
 * pneumatic run valve (its pilot on the ASI PDB), two vent solenoids, two reliefs. On the vehicle: TC-1 in the ASI body. This tab shows them
 * live, derives flow and O/F from the hole pressures (as the design point uses
 * PT-LP-1/2), and walks the pre-fire checks with a pass/fail log.
 *
 * Valve buttons are the stand's own actuator cards: they move a valve only when
 * the console is armed and in debug mode, exactly as on every other tab. Nothing
 * here commands hardware on its own; the tests only watch.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import ActuatorControlByName from '@/components/controls/ActuatorControlByName';
import AsiSchematic from '@/components/asi/AsiSchematic';
import { ASI_COLORS, NumField, Panel, Stat, SubTabs, VerdictBadge, fmt, useAsiHardware, type AsiHardware } from '@/components/asi/AsiParts';
import { useActuatorCommandedState, useGetSensorValue, useSensorValue } from '@/lib/store';
import { ActuatorState } from '@/lib/types';
import { useAsiSettings, type AsiMapping, type AsiModel, type LineId } from '@/lib/asi/settings';
import {
  leakDecay, ofFromPts, reliefCrack, reliefMargin, tcAmbientCheck, valveResponse, zeroCheck, type Sample, type Verdict,
} from '@/lib/asi/checks';
import { operatingPoint } from '@/lib/asi/engine';

// ── Results log ──────────────────────────────────────────────────────────────

interface LogRow { at: string; test: string; item: string; value: string; verdict: Verdict; note: string }
const LOG_KEY = 'asi.testlog.v1';

function loadLog(): LogRow[] {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) ?? '[]') as LogRow[]; } catch { return []; }
}

function useTestLog() {
  const [rows, setRows] = useState<LogRow[]>(loadLog);
  const add = useCallback((r: Omit<LogRow, 'at'>) => {
    setRows((prev) => {
      const next = [{ ...r, at: new Date().toISOString() }, ...prev].slice(0, 500);
      try { localStorage.setItem(LOG_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const clear = useCallback(() => {
    setRows([]);
    try { localStorage.removeItem(LOG_KEY); } catch { /* ignore */ }
  }, []);
  return { rows, add, clear };
}

function exportCsv(rows: LogRow[]) {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const csv = ['time,test,item,value,verdict,note', ...rows.map((r) => [r.at, r.test, r.item, r.value, r.verdict, r.note].map(esc).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `asi-test-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Live readings ────────────────────────────────────────────────────────────

function useAsiLive(hw: AsiHardware) {
  const e = hw.entities;
  const goxUp = useSensorValue(e.goxUp, 'pressure_psi');
  const goxDn = useSensorValue(e.goxDn, 'pressure_psi');
  const ch4Up = useSensorValue(e.ch4Up, 'pressure_psi');
  const ch4Dn = useSensorValue(e.ch4Dn, 'pressure_psi');
  const tc = useSensorValue(e.tc, 'temperature_c');
  const goxAct = hw.actuator(hw.mapping.goxValve);
  const ch4Act = hw.actuator(hw.mapping.ch4Valve);
  const goxCmd = useActuatorCommandedState(goxAct?.entity ?? '');
  const ch4Cmd = useActuatorCommandedState(ch4Act?.entity ?? '');
  const v = (name: string) => hw.actuator(name);
  const gvu = v(hw.mapping.goxVentUp); const gvd = v(hw.mapping.goxVentDn);
  const cvu = v(hw.mapping.ch4VentUp); const cvd = v(hw.mapping.ch4VentDn);
  const gvuCmd = useActuatorCommandedState(gvu?.entity ?? '');
  const gvdCmd = useActuatorCommandedState(gvd?.entity ?? '');
  const cvuCmd = useActuatorCommandedState(cvu?.entity ?? '');
  const cvdCmd = useActuatorCommandedState(cvd?.entity ?? '');
  const pos = (s: ActuatorState | null, mapped: boolean) => (!mapped || s === null ? null : s === ActuatorState.OPEN ? 1 : 0);
  return {
    goxUp, goxDn, ch4Up, ch4Dn, tc,
    goxValve: pos(goxCmd, !!goxAct), ch4Valve: pos(ch4Cmd, !!ch4Act),
    goxVents: [pos(gvuCmd, !!gvu), pos(gvdCmd, !!gvd)] as [number | null, number | null],
    ch4Vents: [pos(cvuCmd, !!cvu), pos(cvdCmd, !!cvd)] as [number | null, number | null],
    goxCmd, ch4Cmd,
    cmds: { goxValve: goxCmd, ch4Valve: ch4Cmd, goxVentUp: gvuCmd, goxVentDn: gvdCmd, ch4VentUp: cvuCmd, ch4VentDn: cvdCmd },
  };
}
type Live = ReturnType<typeof useAsiLive>;

// ── Mapping ──────────────────────────────────────────────────────────────────

const MAP_FIELDS: { key: keyof AsiMapping; label: string; kind: 'pt' | 'tc' | 'act' }[] = [
  { key: 'goxUp', label: 'GOx upstream PT', kind: 'pt' },
  { key: 'goxDn', label: 'GOx downstream PT', kind: 'pt' },
  { key: 'ch4Up', label: 'CH4 upstream PT', kind: 'pt' },
  { key: 'ch4Dn', label: 'CH4 downstream PT', kind: 'pt' },
  { key: 'tc', label: 'ASI TC (TC-1)', kind: 'tc' },
  { key: 'goxValve', label: 'GOx run valve', kind: 'act' },
  { key: 'ch4Valve', label: 'CH4 run valve', kind: 'act' },
  { key: 'goxVentUp', label: 'GOx vent before valve', kind: 'act' },
  { key: 'goxVentDn', label: 'GOx vent after valve', kind: 'act' },
  { key: 'ch4VentUp', label: 'CH4 vent before valve', kind: 'act' },
  { key: 'ch4VentDn', label: 'CH4 vent after valve', kind: 'act' },
  { key: 'spark', label: 'Spark / exciter', kind: 'act' },
];

function MappingPanel({ hw }: { hw: AsiHardware }) {
  const { settings, setMapping } = useAsiSettings();
  const options = (kind: 'pt' | 'tc' | 'act') => (kind === 'pt' ? hw.ptRoles : kind === 'tc' ? hw.tcRoles : hw.actuatorNames);
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-1 md:grid-cols-2 xl:grid-cols-4">
      {MAP_FIELDS.map((f) => {
        const explicit = settings.mapping[f.key];
        const auto = hw.auto[f.key];
        return (
          <label key={f.key} className="flex flex-col gap-0.5 py-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-3">{f.label}</span>
            <select
              value={explicit}
              onChange={(e) => setMapping({ [f.key]: e.target.value })}
              className="border border-line-strong bg-black px-1.5 py-1 font-mono text-[12px] text-ink"
            >
              <option value="">{auto ? `auto: ${auto}` : 'auto: not found'}</option>
              {options(f.kind).map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
        );
      })}
      <p className="col-span-full pt-1 font-mono text-[10px] leading-relaxed text-ink-4">
        Roles come from config.toml ([sensor_roles_*], [actuator_roles]). Naming a role by its P&ID tag
        (e.g. &quot;PT-LP-5&quot;) or as &quot;ASI GOx Upstream&quot; lets auto-detect find it.
      </p>
    </div>
  );
}

// ── Line card ────────────────────────────────────────────────────────────────

/** One PDB output: the stand's own actuator card when mapped, else what is missing. */
function ActuatorSlot({ label, name, hw, empty }: { label: string; name: string; hw: AsiHardware; empty: string }) {
  const act = hw.actuator(name);
  if (act) return <ActuatorControlByName name={act.name} channel={act.channel} entity={act.entity} boardId={act.boardId} ballValve={act.ballValve} />;
  return (
    <div className="flex h-full flex-col items-center justify-center border border-dashed border-line px-1 text-center font-mono text-[10px] text-ink-4" title={label}>
      <span className="text-ink-3">{label}</span>
      <span>{name ? `“${name}” not in [actuator_roles]` : empty}</span>
    </div>
  );
}

function LineCard({ id, hw, live }: { id: LineId; hw: AsiHardware; live: Live }) {
  const { settings } = useAsiSettings();
  const l = settings.model[id];
  const up = id === 'gox' ? live.goxUp : live.ch4Up;
  const dn = id === 'gox' ? live.goxDn : live.ch4Dn;
  const color = id === 'gox' ? ASI_COLORS.gox : ASI_COLORS.ch4;
  const valveName = id === 'gox' ? hw.mapping.goxValve : hw.mapping.ch4Valve;
  const regDev = up !== null ? up - l.supplyPsig : null;
  return (
    <Panel title={<span style={{ color }}>{id === 'gox' ? 'GOx line' : 'CH4 line'}</span>}>
      <div className="grid grid-cols-2 gap-2">
        <Stat label={`${l.tags.upstreamPt} · up`} value={fmt(up, 0)} unit="psig" color={color}
          hint={`Regulator ${l.tags.regulator} set ${l.supplyPsig} psig`} />
        <Stat label={`${l.tags.downstreamPt} · down`} value={fmt(dn, 0)} unit="psig" color={color} />
      </div>
      <div className="mt-1 font-mono text-[10px] text-ink-3">
        {l.tags.regulator} set {l.supplyPsig} psig · deviation {regDev === null ? '—' : `${regDev >= 0 ? '+' : ''}${regDev.toFixed(0)} psi`}
      </div>
      <div className="mt-2 grid h-[72px] grid-cols-3 gap-1.5">
        <ActuatorSlot label={`Run #${l.valveConnector}`} name={valveName} hw={hw} empty="Run valve not mapped" />
        <ActuatorSlot label={`${l.vents[0].name} #${l.vents[0].connector}`} name={id === 'gox' ? hw.mapping.goxVentUp : hw.mapping.ch4VentUp} hw={hw} empty="Vent not mapped" />
        <ActuatorSlot label={`${l.vents[1].name} #${l.vents[1].connector}`} name={id === 'gox' ? hw.mapping.goxVentDn : hw.mapping.ch4VentDn} hw={hw} empty="Vent not mapped" />
      </div>
      <div className="mt-2 flex flex-col gap-1.5">
        {l.reliefs.map((r) => {
          const p = r.location === 'upstream' ? up : dn;
          const m = reliefMargin(p, r.setPsig);
          const bar = m.status === 'over' ? 'bg-red-500' : m.status === 'warn' ? 'bg-amber-500' : 'bg-green-600';
          return (
            <div key={r.name}>
              <div className="flex justify-between font-mono text-[10px] text-ink-3">
                <span>{r.name} · {r.location} · set {r.setPsig} psig</span>
                <span>{m.status === 'none' ? '—' : `${Math.round(m.frac * 100)} %`}</span>
              </div>
              <div className="h-1.5 w-full bg-[#161616]">
                <div className={`h-full ${bar}`} style={{ width: `${Math.min(100, m.frac * 100)}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ── Derived (what the hole PTs imply) ────────────────────────────────────────

function DerivedCard({ live }: { live: Live }) {
  const { settings } = useAsiSettings();
  const m = settings.model;
  const d = ofFromPts(m, live.goxDn, live.ch4Dn);
  const op = useMemo(() => {
    if (live.goxDn === null || live.ch4Dn === null || live.goxDn < 20 || live.ch4Dn < 20) return null;
    return operatingPoint(m, Math.round(live.goxDn), Math.round(live.ch4Dn));
  }, [m, live.goxDn, live.ch4Dn]);
  return (
    <Panel title="ASI · from the hole PTs">
      <div className="grid grid-cols-2 gap-2">
        <Stat label="TC-1 (body)" value={fmt(live.tc, 1)} unit="°C" color={ASI_COLORS.tc} hint="Copper 1 mm from the bore, not gas temperature" />
        <Stat label="O/F (cold, choked)" value={fmt(d.of, 2)} color={d.of === null ? undefined : d.lightable ? ASI_COLORS.of : '#f87171'}
          hint={`Lights between O/F ${m.ofMin} and ${m.ofMax}`} />
        <Stat label="ṁ GOx" value={fmt(d.mdotOx_gs, 1)} unit="g/s" color={ASI_COLORS.gox} />
        <Stat label="ṁ CH4" value={fmt(d.mdotF_gs, 1)} unit="g/s" color={ASI_COLORS.ch4} />
        <Stat label="Pc if lit" value={fmt(op?.pcPsia, 0)} unit="psia" color={ASI_COLORS.pc}
          hint="The twin's chamber solve at these hole pressures, burning" />
        <Stat label="Gate" value={op ? (op.pcPsia >= m.gatePcPsia ? 'PASS' : 'FAIL') : '—'}
          color={op ? (op.pcPsia >= m.gatePcPsia ? '#4ade80' : '#f87171') : undefined}
          hint={`Light gate: Pc > ${m.gatePcPsia} psia within ${m.gateMs} ms`} />
      </div>
      <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink-4">
        Flow from hole P0 by the choked-orifice equation (Cd {m.gox.holeCd}/{m.ch4.holeCd}, assumed until each insert is cold-flowed).
      </p>
    </Panel>
  );
}

// ── Procedures ───────────────────────────────────────────────────────────────

type Proc = 'zero' | 'leak' | 'valve' | 'relief' | 'coldflow';
const PROCS: { id: Proc; label: string }[] = [
  { id: 'zero', label: '1 · Zero / ambient' },
  { id: 'leak', label: '2 · Leak decay' },
  { id: 'valve', label: '3 · Valve response' },
  { id: 'relief', label: '4 · Relief crack' },
  { id: 'coldflow', label: '5 · Cold-flow O/F' },
];

type NodeKey = 'goxUp' | 'goxDn' | 'ch4Up' | 'ch4Dn';
const NODE_LABEL: Record<NodeKey, string> = { goxUp: 'GOx upstream', goxDn: 'GOx downstream', ch4Up: 'CH4 upstream', ch4Dn: 'CH4 downstream' };

function Procedures({ hw, live, log }: { hw: AsiHardware; live: Live; log: ReturnType<typeof useTestLog> }) {
  const [proc, setProc] = useState<Proc>('zero');
  return (
    <Panel title="Test procedures" className="min-h-[260px]">
      <SubTabs<Proc> tabs={PROCS} value={proc} onChange={setProc} />
      <div className="pt-3">
        {proc === 'zero' && <ZeroTest live={live} hw={hw} log={log} />}
        {proc === 'leak' && <LeakTest live={live} log={log} />}
        {proc === 'valve' && <ValveTest hw={hw} live={live} log={log} />}
        {proc === 'relief' && <ReliefTest live={live} log={log} />}
        {proc === 'coldflow' && <ColdFlowTest live={live} log={log} />}
      </div>
    </Panel>
  );
}

const Hint = ({ children }: { children: React.ReactNode }) => (
  <p className="mb-2 max-w-3xl font-mono text-[11px] leading-relaxed text-ink-3">{children}</p>
);

function ZeroTest({ live, hw, log }: { live: Live; hw: AsiHardware; log: ReturnType<typeof useTestLog> }) {
  const [tol, setTol] = useState(5);
  const [amb, setAmb] = useState(20);
  const [tolC, setTolC] = useState(8);
  const run = () => {
    (Object.keys(NODE_LABEL) as NodeKey[]).forEach((k) => {
      const z = zeroCheck(live[k], tol);
      log.add({ test: 'Zero', item: `${NODE_LABEL[k]} (${hw.mapping[k] || 'unmapped'})`, value: z.offset === null ? 'no data' : `${z.offset.toFixed(1)} psig`, verdict: z.verdict, note: `tol ±${tol} psig` });
    });
    const t = tcAmbientCheck(live.tc, amb, tolC);
    log.add({ test: 'Zero', item: `TC-1 (${hw.mapping.tc || 'unmapped'})`, value: t.offset === null ? 'no data' : `${live.tc?.toFixed(1)} °C`, verdict: t.verdict, note: `ambient ${amb} ±${tolC} °C` });
  };
  return (
    <div>
      <Hint>Lines vented to atmosphere, valves shut, ASI cold. Every PT should read ~0 psig and TC-1 the room.</Hint>
      <div className="grid max-w-md grid-cols-1">
        <NumField label="PT tolerance" unit="psig" value={tol} onChange={setTol} note="0.5 % of a 1000 psi PT-LP span = 5 psi" />
        <NumField label="Ambient" unit="°C" value={amb} onChange={setAmb} />
        <NumField label="TC tolerance" unit="°C" value={tolC} onChange={setTolC} />
      </div>
      <button type="button" className="ctl mt-2 px-3 py-1.5 text-[11px]" onClick={run}>Check now</button>
    </div>
  );
}

function LeakTest({ live, log }: { live: Live; log: ReturnType<typeof useTestLog> }) {
  const [node, setNode] = useState<NodeKey>('goxUp');
  const [durS, setDurS] = useState(60);
  const [maxRate, setMaxRate] = useState(2);
  const [run, setRun] = useState<{ t0: number; p0: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const value = live[node];
  useEffect(() => {
    if (!run) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [run]);
  const elapsed = run ? (now - run.t0) / 1000 : 0;
  const finish = useCallback(() => {
    if (!run || value === null) return;
    const r = leakDecay(run.p0, value, (Date.now() - run.t0) / 1000, maxRate);
    log.add({ test: 'Leak decay', item: NODE_LABEL[node], value: `${run.p0.toFixed(1)} → ${value.toFixed(1)} psig, ${r.ratePsiPerMin.toFixed(2)} psi/min`, verdict: r.verdict, note: `${((Date.now() - run.t0) / 1000).toFixed(0)} s, limit ${maxRate} psi/min` });
    setRun(null);
  }, [run, value, maxRate, node, log]);
  useEffect(() => { if (run && elapsed >= durS) finish(); }, [run, elapsed, durS, finish]);
  const rate = run && value !== null && elapsed > 1 ? ((run.p0 - value) / elapsed) * 60 : null;
  return (
    <div>
      <Hint>
        Pressurise, then lock the volume up (regulator isolated for the upstream node, run valve shut for the downstream one) and
        watch it decay. The design point calls for a 630 psig GN2 bench leak test before first fire. A rising pressure is flagged:
        a creeping regulator or a run valve passing into a trapped volume.
      </Hint>
      <div className="grid max-w-md grid-cols-1">
        <label className="flex items-center justify-between py-0.5">
          <span className="font-mono text-[11px] text-ink-2">Volume</span>
          <select value={node} disabled={!!run} onChange={(e) => setNode(e.target.value as NodeKey)} className="border border-line-strong bg-black px-1 py-0.5 font-mono text-[12px] text-ink">
            {(Object.keys(NODE_LABEL) as NodeKey[]).map((k) => <option key={k} value={k}>{NODE_LABEL[k]}</option>)}
          </select>
        </label>
        <NumField label="Hold" unit="s" value={durS} onChange={setDurS} />
        <NumField label="Max decay" unit="psi/min" value={maxRate} onChange={setMaxRate} note="Assumed acceptance; set to your procedure's" />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {!run ? (
          <button type="button" className="ctl px-3 py-1.5 text-[11px]" disabled={value === null} onClick={() => value !== null && setRun({ t0: Date.now(), p0: value })}>Start hold</button>
        ) : (
          <button type="button" className="ctl px-3 py-1.5 text-[11px]" onClick={finish}>Stop & record</button>
        )}
        <span className="font-mono text-[12px] text-ink-2">
          now {fmt(value, 1)} psig
          {run && <> · start {run.p0.toFixed(1)} · {elapsed.toFixed(0)}/{durS} s · {fmt(rate, 2)} psi/min</>}
        </span>
      </div>
    </div>
  );
}

type ActKey = 'goxValve' | 'goxVentUp' | 'goxVentDn' | 'ch4Valve' | 'ch4VentUp' | 'ch4VentDn';

/** Each PDB output, the PT that answers it, and its stroke spec. */
function actuatorTargets(m: AsiModel): { key: ActKey; label: string; node: NodeKey; openMs: number; closeMs: number }[] {
  const out: { key: ActKey; label: string; node: NodeKey; openMs: number; closeMs: number }[] = [];
  (['gox', 'ch4'] as const).forEach((id) => {
    const l = m[id];
    const name = id === 'gox' ? 'GOx' : 'CH4';
    out.push({ key: `${id}Valve` as ActKey, label: `${name} pneumatic run valve (#${l.valveConnector} pilot)`, node: `${id}Dn` as NodeKey, openMs: l.valveOpenMs, closeMs: l.valveCloseMs });
    l.vents.forEach((v, i) => out.push({
      key: `${id}Vent${i === 0 ? 'Up' : 'Dn'}` as ActKey,
      label: `${name} vent ${v.name} (#${v.connector}, ${v.location === 'upstream' ? 'before' : 'after'} valve)`,
      node: `${id}${v.location === 'upstream' ? 'Up' : 'Dn'}` as NodeKey, openMs: v.openMs, closeMs: v.closeMs,
    }));
  });
  return out;
}

function ValveTest({ hw, live, log }: { hw: AsiHardware; live: Live; log: ReturnType<typeof useTestLog> }) {
  const { settings } = useAsiSettings();
  const targets = actuatorTargets(settings.model);
  const [key, setKey] = useState<ActKey>('goxValve');
  const [armed, setArmed] = useState(false);
  const [trace, setTrace] = useState<{ samples: Sample[]; dir: string } | null>(null);
  const get = useGetSensorValue();
  const target = targets.find((t) => t.key === key)!;
  const entity = hw.entities[target.node];
  const cmd = live.cmds[key];
  const prevCmd = useRef(cmd);

  useEffect(() => {
    const before = prevCmd.current;
    prevCmd.current = cmd;
    if (!armed || before === cmd || cmd === null || before === null) return;
    // The command changed while armed: record the PT that answers this output for 2 s.
    const t0 = performance.now();
    const samples: Sample[] = [];
    const id = window.setInterval(() => {
      const v = get(entity, 'pressure_psi');
      if (v !== null) samples.push({ t: (performance.now() - t0) / 1000, v });
      if (performance.now() - t0 > 2000) {
        window.clearInterval(id);
        const dir = cmd === ActuatorState.OPEN ? 'open' : 'close';
        const r = valveResponse(samples, 0);
        const limit = dir === 'open' ? target.openMs : target.closeMs;
        const verdict: Verdict = r.ms === null ? 'fail' : r.ms <= limit ? 'pass' : 'warn';
        log.add({
          test: 'Valve response', item: `${target.label} ${dir}`,
          value: r.ms === null ? 'no pressure change' : `${r.ms.toFixed(0)} ms to 90 % (${r.from.toFixed(0)} → ${r.to.toFixed(0)} psig)`,
          verdict, note: `spec ≤ ${limit} ms; GUI stream ~20 pts/s, so ±50 ms`,
        });
        setTrace({ samples, dir });
        setArmed(false);
      }
    }, 10);
    return () => window.clearInterval(id);
  }, [cmd, armed, entity, get, log, target.label, target.openMs, target.closeMs]);

  return (
    <div>
      <Hint>
        Arm, then actuate the output from its card above (console armed). A run valve is timed on the downstream PT
        rising; a vent on its own volume&apos;s PT falling. Each is timed to 90 % of the change against its stroke setting
        in the Twin&apos;s model (the run valves are pneumatic: pilot + actuator fill, so set their stroke from this test). The GUI stream is ~20 points/s, so this resolves ~50 ms: it finds a dead or
        slow valve, not a stroke time — use the oscilloscope / encoder views or the logged data for that.
      </Hint>
      <div className="flex flex-wrap items-center gap-3">
        <select value={key} disabled={armed} onChange={(e) => setKey(e.target.value as ActKey)} className="border border-line-strong bg-black px-1 py-1 font-mono text-[12px] text-ink">
          {targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <button type="button" className="ctl px-3 py-1.5 text-[11px]" disabled={!entity || !hw.mapping[key]} onClick={() => setArmed((a) => !a)}>
          {armed ? 'Disarm' : 'Arm'}
        </button>
        <span className="font-mono text-[11px] text-ink-3">
          {!hw.mapping[key] ? 'Output not mapped' : !entity ? `${NODE_LABEL[target.node]} PT not mapped` : armed ? 'Armed: waiting for a command…' : `watches ${NODE_LABEL[target.node]} PT`}
        </span>
      </div>
      {trace && (
        <div className="mt-2 font-mono text-[11px] text-ink-3">
          Last: {trace.dir}, {trace.samples.length} samples over 2 s.
        </div>
      )}
    </div>
  );
}

function ReliefTest({ live, log }: { live: Live; log: ReturnType<typeof useTestLog> }) {
  const { settings } = useAsiSettings();
  const all = (['gox', 'ch4'] as const).flatMap((id) => settings.model[id].reliefs.map((r) => ({ id, r })));
  const [idx, setIdx] = useState(0);
  const [tolPct, setTolPct] = useState(5);
  const [peak, setPeak] = useState<number | null>(null);
  const sel = all[Math.min(idx, all.length - 1)];
  const node: NodeKey = `${sel.id}${sel.r.location === 'upstream' ? 'Up' : 'Dn'}` as NodeKey;
  const v = live[node];
  useEffect(() => { if (v !== null) setPeak((p) => (p === null ? v : Math.max(p, v))); }, [v]);
  useEffect(() => setPeak(null), [idx]);
  const mark = (p: number | null, how: string) => {
    if (p === null) return;
    const r = reliefCrack(p, sel.r.setPsig, tolPct);
    log.add({ test: 'Relief crack', item: sel.r.name, value: `${p.toFixed(0)} psig (${r.errorPct >= 0 ? '+' : ''}${r.errorPct.toFixed(1)} %)`, verdict: r.verdict, note: `${how}; set ${sel.r.setPsig} ±${tolPct} %` });
  };
  return (
    <div>
      <Hint>
        Bench test with GN2 (not GOx): raise the protected volume slowly past the set point and mark the pressure the relief
        cracks at — the plateau, or the peak it holds. Regulators lock up at 645 psig, so the 725/750 psig reliefs need a
        bench source above that.
      </Hint>
      <div className="grid max-w-md grid-cols-1">
        <label className="flex items-center justify-between py-0.5">
          <span className="font-mono text-[11px] text-ink-2">Relief</span>
          <select value={idx} onChange={(e) => setIdx(Number(e.target.value))} className="border border-line-strong bg-black px-1 py-0.5 font-mono text-[12px] text-ink">
            {all.map((a, i) => <option key={a.r.name + i} value={i}>{a.r.name} · {a.id === 'gox' ? 'GOx' : 'CH4'} {a.r.location} · set {a.r.setPsig}</option>)}
          </select>
        </label>
        <NumField label="Tolerance" unit="%" value={tolPct} onChange={setTolPct} note="Assumed acceptance (typical ±3–5 % of set)" />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className="font-mono text-[12px] text-ink-2">{NODE_LABEL[node]} {fmt(v, 0)} psig · peak {fmt(peak, 0)}</span>
        <button type="button" className="ctl px-3 py-1.5 text-[11px]" disabled={v === null} onClick={() => mark(v, 'marked live')}>Mark crack now</button>
        <button type="button" className="ctl px-3 py-1.5 text-[11px]" disabled={peak === null} onClick={() => mark(peak, 'peak hold')}>Record peak</button>
        <button type="button" className="ctl px-3 py-1.5 text-[11px]" onClick={() => setPeak(null)}>Reset peak</button>
      </div>
    </div>
  );
}

function ColdFlowTest({ live, log }: { live: Live; log: ReturnType<typeof useTestLog> }) {
  const { settings } = useAsiSettings();
  const [target, setTarget] = useState(2.5);
  const [tol, setTol] = useState(10);
  const d = ofFromPts(settings.model, live.goxDn, live.ch4Dn);
  const capture = () => {
    if (d.of === null) return;
    const err = ((d.of - target) / target) * 100;
    log.add({
      test: 'Cold-flow O/F', item: 'both run valves open, no spark',
      value: `O/F ${d.of.toFixed(2)} (GOx ${d.mdotOx_gs?.toFixed(1)} g/s, CH4 ${d.mdotF_gs?.toFixed(1)} g/s @ ${live.goxDn?.toFixed(0)}/${live.ch4Dn?.toFixed(0)} psig)`,
      verdict: Math.abs(err) <= tol ? 'pass' : 'fail', note: `target ${target} ±${tol} %`,
    });
  };
  return (
    <div>
      <Hint>
        Both run valves open, spark off (GN2 in place of GOx on the bench if your procedure says so — the flow numbers then
        assume GOx and read high by ~6 %). Flow and O/F come from the hole pressures through the choked-orifice equation.
      </Hint>
      <div className="grid max-w-md grid-cols-1">
        <NumField label="Target O/F" value={target} onChange={setTarget} note="Design point 2.5" />
        <NumField label="Tolerance" unit="%" value={tol} onChange={setTol} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className="font-mono text-[12px] text-ink-2">O/F {fmt(d.of, 2)} · GOx {fmt(d.mdotOx_gs, 1)} g/s · CH4 {fmt(d.mdotF_gs, 1)} g/s</span>
        <button type="button" className="ctl px-3 py-1.5 text-[11px]" disabled={d.of === null} onClick={capture}>Capture</button>
      </div>
    </div>
  );
}

function LogPanel({ log }: { log: ReturnType<typeof useTestLog> }) {
  return (
    <Panel
      title={`Results · ${log.rows.length}`}
      right={(
        <span className="flex gap-2">
          <button type="button" className="ctl px-2 py-0.5 text-[10px]" disabled={!log.rows.length} onClick={() => exportCsv(log.rows)}>CSV</button>
          <button type="button" className="ctl px-2 py-0.5 text-[10px]" disabled={!log.rows.length} onClick={log.clear}>Clear</button>
        </span>
      )}
    >
      <div className="max-h-[320px] overflow-auto">
        {log.rows.length === 0 ? (
          <p className="font-mono text-[11px] text-ink-4">No results yet.</p>
        ) : (
          <table className="w-full font-mono text-[11px]">
            <tbody>
              {log.rows.map((r, i) => (
                <tr key={i} className="border-b border-line align-top">
                  <td className="whitespace-nowrap py-1 pr-2 text-ink-4">{r.at.slice(11, 19)}</td>
                  <td className="py-1 pr-2 text-ink-2">{r.test}<div className="text-ink-3">{r.item}</div></td>
                  <td className="py-1 pr-2 text-ink">{r.value}<div className="text-ink-4">{r.note}</div></td>
                  <td className="py-1"><VerdictBadge verdict={r.verdict} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AsiTestPage() {
  const hw = useAsiHardware();
  const live = useAsiLive(hw);
  const log = useTestLog();
  const { settings } = useAsiSettings();
  const [showMap, setShowMap] = useState(false);
  const sparkAct = hw.actuator(hw.mapping.spark);

  const pts = ([
    ['goxUp', `GOx up ${settings.model.gox.tags.upstreamPt}`, ASI_COLORS.gox],
    ['goxDn', `GOx dn ${settings.model.gox.tags.downstreamPt}`, ASI_COLORS.goxDn],
    ['ch4Up', `CH4 up ${settings.model.ch4.tags.upstreamPt}`, ASI_COLORS.ch4],
    ['ch4Dn', `CH4 dn ${settings.model.ch4.tags.downstreamPt}`, ASI_COLORS.ch4Dn],
  ] as const).filter(([k]) => hw.entities[k]);

  return (
    <main className="flex h-full flex-col gap-3 overflow-auto bg-background px-4 py-4 text-text sm:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="h-2 w-2 flex-shrink-0" style={{ backgroundColor: ASI_COLORS.pc }} />
          <h1 className="font-mono text-[15px] font-semibold uppercase tracking-[0.32em] text-ink">ASI System Test</h1>
          <span className="font-mono text-[11px] text-ink-3">GOx / CH4 augmented spark igniter</span>
        </div>
        <button type="button" className="ctl px-3 py-1 text-[11px]" onClick={() => setShowMap((s) => !s)}>
          {showMap ? 'Hide' : 'Sensor & valve'} mapping
        </button>
      </div>

      {showMap && <Panel title="Mapping: ASI part → DAQ role"><MappingPanel hw={hw} /></Panel>}

      <Panel title="Feed lines · live">
        <AsiSchematic
          model={settings.model}
          gox={{ upPsig: live.goxUp, dnPsig: live.goxDn, valve: live.goxValve, vents: live.goxVents }}
          ch4={{ upPsig: live.ch4Up, dnPsig: live.ch4Dn, valve: live.ch4Valve, vents: live.ch4Vents }}
          tcC={live.tc}
          caption="LIVE"
        />
      </Panel>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <LineCard id="gox" hw={hw} live={live} />
        <LineCard id="ch4" hw={hw} live={live} />
        <div className="flex flex-col gap-3">
          <DerivedCard live={live} />
          {sparkAct && (
            <div className="h-[72px]">
              <ActuatorControlByName name={sparkAct.name} channel={sparkAct.channel} entity={sparkAct.entity} boardId={sparkAct.boardId} ballValve={sparkAct.ballValve} />
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <div className="h-[300px] min-w-0 border border-line bg-card p-2 xl:col-span-2">
          {pts.length ? (
            <TimeSeriesPlot title="ASI pressures (psig)" entities={pts.map(([k]) => hw.entities[k])} labels={pts.map(([, l]) => l)}
              colors={pts.map(([, , c]) => c)} component="pressure_psi" yLabel="psig" windowSeconds={60} />
          ) : (
            <div className="flex h-full items-center justify-center font-mono text-[11px] text-ink-4">No ASI PTs mapped — open “Sensor & valve mapping”.</div>
          )}
        </div>
        <div className="h-[300px] min-w-0 border border-line bg-card p-2">
          {hw.entities.tc ? (
            <TimeSeriesPlot title="TC-1 (°C)" entities={[hw.entities.tc]} labels={['TC-1']} colors={[ASI_COLORS.tc]}
              component="temperature_c" yLabel="°C" windowSeconds={60} />
          ) : (
            <div className="flex h-full items-center justify-center font-mono text-[11px] text-ink-4">ASI TC not mapped.</div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Procedures hw={hw} live={live} log={log} />
        <LogPanel log={log} />
      </div>
    </main>
  );
}
