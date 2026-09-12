'use client'

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useSensorStore } from '@/lib/store';
import { useSensorConfig } from '@/lib/sensor-config';
import { useControlMode } from '@/lib/control-mode';
import { loadStates, flowStateId, flowSettings, stateIdByName, stateName } from '@/lib/states';
import { getApiBaseUrl, getWebSocketClient } from '@/lib/websocket';
import { getEntityColor } from '@/lib/sensor-colors';
import { MessageType } from '@/lib/types';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Label,
  LineChart,
  Line,
  Legend,
  ReferenceArea,
} from 'recharts';
import {
  type PressureSample,
  median,
  mean,
  sampleStdev,
  coefficientOfVariationPercent,
  computeCdAIntegral,
  reynoldsPipe,
  sliceSamplesByTime,
  upstreamSlopePsiPerSec,
  averagePressures,
  deltaPSeries,
} from '@/lib/feed-characterization-utils';

interface CharacterizationResult {
  id: number;
  timestamp: string;
  system: string;
  fluid: string;
  flowTime: number;
  totalMass: number;
  mdot: number;
  avgPUp: number;
  avgPDown: number;
  deltaP: number;
  cda: number;
  re: number;
  mode: 'manual' | 'timed_spike';
  baselineDownPsi?: number;
  spikeTimeSec?: number;
  sampleCount?: number;
  stdevDeltaPsi?: number;
  cvDeltaPPercent?: number;
}

const FLUID_PROPERTIES: Record<string, { density: number; viscosity: number }> = {
  LOX: { density: 1141, viscosity: 1.9e-4 },
  Kerosene: { density: 810, viscosity: 2.4e-3 },
  Water: { density: 1000, viscosity: 8.9e-4 },
  GN2: { density: 1.25, viscosity: 1.8e-5 },
  Custom: { density: 1000, viscosity: 1e-3 },
};

/**
 * Sentinel for "there is no downstream transducer, the orifice discharges to air".
 *
 * Not a fake sensor: when this is selected P_down is 0 psig by definition and dP is just the
 * upstream gauge reading. A rig that vents to atmosphere has nothing to instrument downstream, and
 * inventing a PT for it would be worse than saying so.
 */
const ATMOSPHERE = '__atmosphere__';

type PulsePhase = 'idle' | 'baselining' | 'wait_spike' | 'flowing' | 'draining';

/**
 * Sampling period for the pressure trace during a run, in ms.
 *
 * This is only how densely the trace is recorded — it is NOT how the valve is timed. The hold is
 * timed in the sequencer against a steady_clock deadline; the browser used to bracket it with two
 * independent round trips and a setTimeout, which made the window "at least N", never N.
 */
const SAMPLE_PERIOD_MS = 25;

/**
 * State that survives leaving the page and coming back.
 *
 * These are the operator's setup choices — which taps, which fluid, how long — and they describe
 * the rig, not the run. Losing them on every navigation meant re-picking the same two PTs all
 * afternoon. localStorage rather than the server because it is a per-operator convenience, not
 * rig state: nothing here changes what the hardware does, and two people on two laptops wanting
 * different working sets is fine.
 *
 * Every access is guarded — a private window or blocked site data throws on read, and that must
 * degrade to "use the default", never to a blank page.
 */
function usePersisted<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const storageKey = `feedChar.${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      /* storage unavailable — the page still works, it just forgets */
    }
  }, [storageKey, value]);
  return [value, setValue];
}

export default function FeedCharacterizationPage() {
  const [flowTime, setFlowTime] = useState<number>(1);
  const [totalMass, setTotalMass] = useState<number>(0.5);
  const [upEntity, setUpEntity] = usePersisted<string>('upEntity', '');
  const [downEntity, setDownEntity] = usePersisted<string>('downEntity', ATMOSPHERE);
  const [selectedFluid, setSelectedFluid] = usePersisted<string>('fluid', 'Water');
  const [customDensity, setCustomDensity] = usePersisted<number>('customDensity', FLUID_PROPERTIES['Water'].density);
  const [customViscosity, setCustomViscosity] = usePersisted<number>('customViscosity', FLUID_PROPERTIES['Water'].viscosity);
  const [diameter, setDiameter] = usePersisted<number>('orificeDiameterM', 0.0254);

  const [commandedDurationSec, setCommandedDurationSec] = usePersisted('durationSec', 1);
  const [baselineMs, setBaselineMs] = usePersisted('baselineMs', 400);
  const [spikeDeltaPsi, setSpikeDeltaPsi] = usePersisted('spikeDeltaPsi', 5);
  const [spikeTimeoutMs, setSpikeTimeoutMs] = usePersisted('spikeTimeoutMs', 15000);
  /** How long to keep following the trace after the valve shuts, waiting for flow to actually stop.
   *  With a catch tank the line drains after close and that mass is on the scale, so it belongs in
   *  the window. */
  const [drainTimeoutMs, setDrainTimeoutMs] = usePersisted('drainTimeoutMs', 3000);

  const [results, setResults] = useState<CharacterizationResult[]>([]);

  const [pulsePhase, setPulsePhase] = useState<PulsePhase>('idle');
  const pulseAbortRef = useRef(false);
  const pulseInFlightRef = useRef(false);
  const pulseSamplesRef = useRef<PressureSample[]>([]);
  const [lastRunSamples, setLastRunSamples] = useState<PressureSample[]>([]);
  const [lastTimedWindow, setLastTimedWindow] = useState<PressureSample[]>([]);
  /** The flow window actually used, so the trace can shade it and the operator can check it. */
  const [lastFlowWindow, setLastFlowWindow] = useState<{ startSec: number; endSec: number } | null>(null);
  const [lastBaselinePsi, setLastBaselinePsi] = useState<number | null>(null);
  const [lastSpikeSec, setLastSpikeSec] = useState<number | null>(null);
  const [pulseStatus, setPulseStatus] = useState('');

  const ws = getWebSocketClient();
  const { controlEnabled, unlock } = useControlMode();
  const debugMode = useSensorStore((s) => s.debugMode);
  const currentState = useSensorStore((s) => s.currentState);

  // The state the sequencer will hold for us, resolved through [[states]].is_flow — never by name,
  // so the operator can rename or move it in Config without touching this page. null means no state
  // is flagged, which disables the run rather than guessing one.
  const [flowState, setFlowState] = useState<number | null>(null);
  const [flowCfg, setFlowCfg] = useState<{ returnTarget: string; durationMs: number | null; maxMs: number | null } | null>(null);
  /** Last backend ERROR frame. The page used to drop these, so a refused command looked like a
   *  run that simply never produced flow. */
  const [pulseError, setPulseError] = useState<string | null>(null);
  /** Set when a result could not be written to the run — usually "no active session". */
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadStates(getApiBaseUrl()).then(() => {
      if (cancelled) return;
      setFlowState(flowStateId());
      const f = flowSettings();
      setFlowCfg(f ? { returnTarget: f.returnTarget, durationMs: f.durationMs, maxMs: f.maxMs } : null);
      if (f?.durationMs) setCommandedDurationSec(f.durationMs / 1000);
    });
    return () => { cancelled = true; };
  }, []);

  // Reload what this run already recorded, so a refresh (or a second operator opening the page)
  // sees the run's results rather than an empty table.
  const reloadResults = useCallback(() => {
    fetch(`${getApiBaseUrl()}/api/feed-char/results`)
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j?.results)) setResults(j.results as CharacterizationResult[]);
      })
      .catch(() => { /* no session, or backend down — the table just stays as it is */ });
  }, []);

  useEffect(() => { reloadResults(); }, [reloadResults]);
  // A session start swaps the run directory underneath us, so the table must follow it.
  useEffect(() => {
    const off = ws.on(MessageType.SESSION_UPDATE, () => reloadResults());
    return off;
  }, [reloadResults, ws]);

  useEffect(() => {
    const off = ws.on(MessageType.ERROR, (p: unknown) => {
      const msg = (p as { message?: string })?.message;
      if (!msg) return;
      setPulseError(msg);
      // A refused command means the run is not happening; stop waiting for flow that cannot come.
      pulseAbortRef.current = true;
    });
    return off;
  }, [ws]);

  // Two different gates, because the two modes ask the sequencer for two different things.
  //
  // Timed mode requests an ordinary STATE TRANSITION, so the transition matrix is the authority:
  // only a state with an edge to the flow state can start one, and Press Standby is the only one
  // that has it. Debug mode is emphatically NOT required, and requiring it would be worse than
  // pointless — debug mode bypasses transition validation entirely, so demanding it here would
  // force the operator to switch OFF the very interlock that makes this safe, to run a routine
  // characterization the interlock already permits.
  //
  // Manual mode is different: it drives individual valves with ACTUATOR: commands, which the
  // sequencer refuses outside debug mode (SequencerService::manualActuator). That mode genuinely
  // needs it.
  //
  // Both need control armed, because the backend rejects control commands from an unarmed
  // connection regardless.
  const canHold = controlEnabled;
  const canManual = controlEnabled && debugMode;
  const maxHoldSec = flowCfg?.maxMs ? flowCfg.maxMs / 1000 : null;
  // The PT list comes from the rig's own [sensor_roles_*], so it follows a config edit with no code
  // change. The page used to hardcode Fuel/LOX/COPV pairs belonging to the full stand — on a rig
  // that does not have those roles every preset resolved to null, dP was never a number, and the
  // run died in the baseline phase before it ever reached the sequencer.
  const allSensors = useSensorConfig();
  const ptSensors = useMemo(
    () => allSensors.filter((x) => /(^PT_Cal\.|^PT\d+_Cal\.)/.test(x.calEntity) && !x.calEntity.includes('RTD')),
    [allSensors],
  );

  // Seed the upstream picker with the first PT so the page is usable without hunting for it.
  // Downstream deliberately stays on Atmosphere: guessing a downstream PT would silently produce a
  // dP across two unrelated taps, which looks like a number and is not one.
  useEffect(() => {
    if (!upEntity && ptSensors.length > 0) setUpEntity(ptSensors[0].calEntity);
  }, [ptSensors, upEntity]);

  const currentUpVal = useSensorStore((s) => (upEntity ? s.getSensorValue(upEntity, 'pressure_psi') : null));
  const currentDownRaw = useSensorStore((s) =>
    downEntity && downEntity !== ATMOSPHERE ? s.getSensorValue(downEntity, 'pressure_psi') : null);
  const ventToAtmosphere = downEntity === ATMOSPHERE;
  const currentDownVal = ventToAtmosphere ? 0 : currentDownRaw;

  const density = selectedFluid === 'Custom' ? customDensity : FLUID_PROPERTIES[selectedFluid].density;
  const viscosity = selectedFluid === 'Custom' ? customViscosity : FLUID_PROPERTIES[selectedFluid].viscosity;

  const liveDeltaP =
    currentUpVal !== null && currentDownVal !== null ? currentUpVal - currentDownVal : null;

  const deltaPChartData = useMemo(
    () =>
      lastRunSamples
        .filter((s) => s.upPsi != null && s.downPsi != null)
        .map((s) => ({
          t: Number(s.tSec.toFixed(3)),
          deltaP: (s.upPsi ?? 0) - (s.downPsi ?? 0),
          down: s.downPsi ?? 0,
        })),
    [lastRunSamples],
  );

  const sampleNow = useCallback(
    (wall0: number): PressureSample => ({
      tSec: (Date.now() - wall0) / 1000,
      upPsi: upEntity ? useSensorStore.getState().getSensorValue(upEntity, 'pressure_psi') : null,
      // Discharging to air: downstream is 0 psig by definition, not an unread sensor.
      downPsi: ventToAtmosphere
        ? 0
        : downEntity
          ? useSensorStore.getState().getSensorValue(downEntity, 'pressure_psi')
          : null,
    }),
    [downEntity, upEntity, ventToAtmosphere],
  );

  const runTimedPulse = useCallback(async () => {
    if (pulsePhase !== 'idle') return;
    if (flowState === null) {
      setPulseStatus('No state is marked as the flow state — tick "Flow" on one in Config.');
      return;
    }
    if (!canHold) {
      setPulseStatus('Arm control first — the backend rejects control commands otherwise.');
      return;
    }

    pulseAbortRef.current = false;
    pulseSamplesRef.current = [];
    const wall0 = Date.now();
    setPulsePhase('baselining');
    setPulseStatus('Baselining downstream (valves closed)…');
    setLastTimedWindow([]);
    setLastSpikeSec(null);
    setPulseError(null);

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    try {
      const baselineDown: number[] = [];
      const baselineUp: number[] = [];
      let upSeen = false;
      const bDeadline = Date.now() + baselineMs;
      while (Date.now() < bDeadline) {
        if (pulseAbortRef.current) throw new Error('aborted');
        const s = sampleNow(wall0);
        pulseSamplesRef.current.push(s);
        if (s.downPsi != null) baselineDown.push(s.downPsi);
        if (s.upPsi != null && Number.isFinite(s.upPsi)) {
          upSeen = true;
          baselineUp.push(s.upPsi);
        }
        await sleep(40);
      }
      const baselinePsi = median(baselineDown.filter(Number.isFinite));
      if (!Number.isFinite(baselinePsi)) {
        // Names the sensor rather than saying "aborted": the usual cause is a PT that is selected
        // but not streaming (no session, or a role that does not exist on this rig), and the old
        // generic message sent people looking at the valves instead of at the sensor.
        throw new Error(
          `No downstream reading from ${downEntity} during the ${baselineMs} ms baseline — ` +
          'is a session running and is that PT streaming?',
        );
      }
      if (!upSeen) {
        throw new Error(
          `No upstream reading from ${upEntity} during the baseline — same check.`,
        );
      }
      const baselineUpPsi = median(baselineUp.filter(Number.isFinite));
      setLastBaselinePsi(baselinePsi);

      // Hand the whole open-hold-close to the sequencer as ONE command. It opens the valves, counts
      // the window against a monotonic deadline, and transitions back — and it is that transition
      // which closes them. The browser's only remaining job is to record the pressure trace.
      //
      // This used to be three browser-timed steps (open, setTimeout, close), so the window was
      // "at least N seconds" plus whatever the event loop and two WebSocket round trips added, and
      // a single janked frame stretched it silently. The mass on the scale was then divided by a
      // duration that never happened.
      const holdMs = Math.round(commandedDurationSec * 1000);
      setPulsePhase('wait_spike');
      setPulseStatus(`Sequencer holding ${(holdMs / 1000).toFixed(3)} s — recording trace…`);
      ws.sendCommand({ commandType: 'state_transition', data: { state: flowState, holdMs } });

      // Observe the entry and exit rather than assuming them: the window that counts is the one the
      // sequencer actually ran, and if it refuses the request we must not sit here pretending.
      let tSpikeSec: number | null = null;
      let entered = false;
      let exited = false;
      let tValveCloseSec: number | null = null;
      const giveUpAt = Date.now() + holdMs + spikeTimeoutMs;
      while (Date.now() < giveUpAt) {
        if (pulseAbortRef.current) break;
        await sleep(SAMPLE_PERIOD_MS);
        const smp = sampleNow(wall0);
        pulseSamplesRef.current.push(smp);

        // Flow start is detected here, not on the server: it comes off the PT stream, and only the
        // GUI has that. The valve window is the sequencer's; the FLOW window is this.
        //
        // Which edge to watch depends on where the fluid goes. Into an instrumented line, flow
        // shows up as downstream RISING. Venting to air there is no downstream signal at all —
        // it is 0 by definition — so the tell is upstream DROOPING as the tank starts to empty.
        if (tSpikeSec == null) {
          const d = smp.downPsi;
          const u = smp.upPsi;
          const started = ventToAtmosphere
            ? u != null && Number.isFinite(u) && Number.isFinite(baselineUpPsi) &&
            u <= baselineUpPsi - spikeDeltaPsi
            : d != null && Number.isFinite(d) && d >= baselinePsi + spikeDeltaPsi;
          if (started) {
            tSpikeSec = smp.tSec;
            setLastSpikeSec(tSpikeSec);
            setPulsePhase('flowing');
          }
        }

        const st = useSensorStore.getState().currentState;
        if (st === flowState) {
          entered = true;
        } else if (entered) {
          exited = true;
          // The authoritative end of commanded flow. Unlike anything read off a pressure trace,
          // this is not inferred — the sequencer left the state, so the valve is shut.
          tValveCloseSec = smp.tSec;
          break;
        }
      }

      // ── After the valve shuts ────────────────────────────────────────────────────────────────
      // For a blowdown the tell is the SLOPE, not the level. The gas charge is consumed by the pull,
      // so upstream decays while flowing and simply stays where it ended — it never climbs back, and
      // a "has it returned to the zero" test can never fire. What does change unmistakably is the
      // rate: steeply negative while flowing, flat once the valves are shut.
      //
      // The threshold is self-calibrating — a fraction of the slope actually observed during this
      // run's flow — so it needs no guess about ullage volume or flow rate, and it works on a hard
      // 150 psi/s pull and a lazy 5 psi/s one alike.
      let tFlowEndSec: number | null = null;
      let flowingSlope = NaN;
      if (exited && tSpikeSec != null) {
        const idxAtClose = pulseSamplesRef.current.length - 1;
        flowingSlope = upstreamSlopePsiPerSec(pulseSamplesRef.current, idxAtClose, 0.3);

        setPulsePhase('draining');
        setPulseStatus('Valve shut — watching the slope flatten…');
        const drainUntil = Date.now() + drainTimeoutMs;
        // Require it to stay flat, so one quiet sample mid-decay cannot end the window early.
        let flatRun = 0;
        while (Date.now() < drainUntil) {
          if (pulseAbortRef.current) break;
          await sleep(SAMPLE_PERIOD_MS);
          const smp = sampleNow(wall0);
          pulseSamplesRef.current.push(smp);

          const slope = upstreamSlopePsiPerSec(
            pulseSamplesRef.current,
            pulseSamplesRef.current.length - 1,
          );
          const d = smp.downPsi;
          let stopped = false;
          if (ventToAtmosphere) {
            // Flat means "no longer draining the tank". Compared against this run's own flowing
            // slope rather than an absolute psi/s, which would be rig- and shot-specific.
            stopped =
              Number.isFinite(slope) && Number.isFinite(flowingSlope) && Math.abs(flowingSlope) > 1
                ? Math.abs(slope) < Math.abs(flowingSlope) * 0.15
                : false;
          } else {
            // An instrumented downstream is caused by the flow, so it does fall back on its own.
            stopped = d != null && Number.isFinite(d) && d <= baselinePsi + spikeDeltaPsi;
          }

          if (stopped) {
            flatRun++;
            if (flatRun >= 3) {
              tFlowEndSec = smp.tSec;
              break;
            }
          } else {
            flatRun = 0;
          }
        }
      }

      const all = [...pulseSamplesRef.current];
      setLastRunSamples(all);

      if (!entered) {
        setPulseStatus('The sequencer never entered the flow state — the run was refused.');
        setPulsePhase('idle');
        return;
      }
      if (!exited) {
        setPulseStatus('Timed out waiting for the hold to end. Check the sequencer.');
        setPulsePhase('idle');
        return;
      }

      if (tSpikeSec == null) {
        setPulseStatus(
          `Hold ran ${(holdMs / 1000).toFixed(3)} s but ` +
          (ventToAtmosphere
            ? `upstream never fell ${spikeDeltaPsi} PSI below its ${baselineUpPsi.toFixed(1)} PSI baseline`
            : `downstream never rose ${spikeDeltaPsi} PSI above its ${baselinePsi.toFixed(1)} PSI baseline`) +
          ' — no flow detected. Nothing to average.',
        );
        setPulsePhase('idle');
        return;
      }

      // Fall back to VALVE CLOSE, not to the last sample. See the drain comment: on a blowdown the
      // stop test cannot fire, and extending to the end of the watch window would integrate seconds
      // of standing pressure as if it were flow.
      const drainNotSeen = tFlowEndSec == null;
      const tEnd = tFlowEndSec ?? tValveCloseSec ?? tSpikeSec;

      const win = sliceSamplesByTime(all, tSpikeSec, tEnd);
      setLastTimedWindow(win);
      setLastFlowWindow({ startSec: tSpikeSec, endSec: tEnd });
      // The window duration IS the flow time — it is what the mass moved over. It is deliberately
      // not the commanded hold; see the drain comment above.
      setFlowTime(tEnd - tSpikeSec);
      setPulseStatus(
        `Done. Valve held ${(holdMs / 1000).toFixed(3)} s; flow ran ` +
        `${(tEnd - tSpikeSec).toFixed(3)} s (t=${tSpikeSec.toFixed(3)} → ${tEnd.toFixed(3)} s)` +
        (drainNotSeen
          ? ` — the upstream slope never flattened within ${drainTimeoutMs} ms`
          + (Number.isFinite(flowingSlope) ? ` (was ${flowingSlope.toFixed(1)} PSI/s while flowing)` : '')
          + '. Window ends at valve close. If it is still draining, something is not sealing.'
          : ' — slope flattened after the valve shut, so the drain is inside the window.') +
        '. Weigh the catch, enter mass, then Calculate.',
      );
    } catch (err) {
      // Report what actually went wrong. This used to print a fixed line about the sequencer
      // closing valves, which was wrong for every failure that happened BEFORE the hold was ever
      // requested — the common case — and pointed the operator at the wrong subsystem.
      const msg = err instanceof Error ? err.message : String(err);
      setPulseStatus(msg === 'aborted' ? 'Cancelled.' : msg);
      setLastRunSamples([...pulseSamplesRef.current]);
    } finally {
      pulseInFlightRef.current = false;
      setPulsePhase('idle');
    }
  }, [baselineMs, canHold, commandedDurationSec, downEntity, drainTimeoutMs, flowState, pulsePhase,
    sampleNow, spikeDeltaPsi, spikeTimeoutMs, upEntity, ventToAtmosphere, ws]);

  const cancelPulse = useCallback(() => {
    pulseAbortRef.current = true;
    // Leaving the flow state is what closes the valves, and the sequencer applies the return
    // state's actuator column when it gets there — so ask for the transition rather than poking
    // individual valves, which would fight the state it is still in.
    if (flowCfg?.returnTarget) {
      const id = stateIdByName(flowCfg.returnTarget);
      if (id !== null) ws.sendCommand({ commandType: 'state_transition', data: { state: id } });
    }
    setPulseStatus('Cancelling — returning to the hold\'s return state, which closes the valves.');
  }, [flowCfg, ws]);



  const calculateCdA = () => {
    let avgPUp: number;
    let avgPDown: number;
    let n: number;
    const mode = 'timed_spike' as const;
    let baselineDownPsi: number | undefined;
    let spikeTimeSec: number | undefined;
    let stdevDeltaPsi: number | undefined;
    let cvDeltaPPercent: number | undefined;

    // Only one mode remains. The manual "open it and time it with your finger" path is gone:
    // its window was the operator's reflexes, and its valve list was hardcoded to roles this rig
    // does not have, so on any stand but the original it opened nothing at all.
    if (lastTimedWindow.length === 0) return;
    const { avgUp, avgDown, n: nn } = averagePressures(lastTimedWindow);
    avgPUp = avgUp;
    avgPDown = avgDown;
    n = nn;
    baselineDownPsi = lastBaselinePsi ?? undefined;
    spikeTimeSec = lastSpikeSec ?? undefined;
    const dps = deltaPSeries(lastTimedWindow);
    stdevDeltaPsi = sampleStdev(dps);
    cvDeltaPPercent = coefficientOfVariationPercent(dps);

    const deltaP_psi = avgPUp - avgPDown;

    // CdA by integration over the flow window, not by dividing averages. See computeCdAIntegral:
    // the orifice relation is instantaneous, so the mass is ∫CdA√(2ρΔP)dt, and on a blowdown ΔP
    // decays right through the window — exactly where averaging-then-rooting is least defensible.
    const cd = computeCdAIntegral({
      totalMassKg: totalMass,
      samples: lastTimedWindow,
      densityKgM3: density,
    });
    if (!cd) return;

    const re = reynoldsPipe(cd.mdotKgS, diameter, viscosity);

    const newResult: CharacterizationResult = {
      id: Date.now(),
      timestamp: new Date().toLocaleTimeString(),
      system: `${upEntity} / ${ventToAtmosphere ? 'atm' : downEntity}`,
      fluid: selectedFluid,
      flowTime: cd.flowTimeSec,
      totalMass,
      mdot: cd.mdotKgS,
      avgPUp,
      avgPDown,
      deltaP: deltaP_psi,
      cda: cd.cdaM2,
      re,
      mode,
      baselineDownPsi,
      spikeTimeSec,
      sampleCount: n,
      stdevDeltaPsi,
      cvDeltaPPercent,
    };

    setResults((prev) => [...prev, newResult]);

    // Persist alongside the run's telemetry. Fire-and-forget: the number is already on screen, and
    // a storage hiccup must not lose it from the session the operator is looking at. A failure is
    // surfaced rather than swallowed, so nobody assumes it was written when it was not.
    fetch(`${getApiBaseUrl()}/api/feed-char/results`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newResult),
    })
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          setSaveError(j?.error || `could not save with the run (HTTP ${r.status})`);
        } else {
          setSaveError(null);
        }
      })
      .catch((e) => setSaveError(String(e)));
  };

  const exportCsv = () => {
    if (results.length === 0) return;
    const headers = [
      'Timestamp',
      'Mode',
      'System',
      'Fluid',
      'Flow Time (s)',
      'Total Mass (kg)',
      'MDOT (kg/s)',
      'Avg P Up (PSI)',
      'Avg P Down (PSI)',
      'Delta P (PSI)',
      'Stdev ΔP (PSI)',
      'CV ΔP %',
      'CdA (m^2)',
      'Reynolds',
      'Baseline Down (PSI)',
      'Spike t (s)',
      'Samples',
    ];
    const rows = results.map((r) => [
      r.timestamp,
      r.mode,
      r.system,
      r.fluid,
      r.flowTime,
      r.totalMass,
      r.mdot.toFixed(4),
      r.avgPUp.toFixed(2),
      r.avgPDown.toFixed(2),
      r.deltaP.toFixed(2),
      r.stdevDeltaPsi?.toFixed(3) ?? '',
      r.cvDeltaPPercent?.toFixed(2) ?? '',
      r.cda.toExponential(4),
      r.re.toExponential(2),
      r.baselineDownPsi?.toFixed(2) ?? '',
      r.spikeTimeSec?.toFixed(4) ?? '',
      r.sampleCount?.toString() ?? '',
    ]);

    const csvContent =
      'data:text/csv;charset=utf-8,' +
      headers.join(',') +
      '\n' +
      rows.map((e) => e.join(',')).join('\n');

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `feed_char_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const exportLastRunJson = () => {
    if (lastRunSamples.length === 0) return;
    const blob = new Blob(
      [
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            system: `${upEntity} / ${ventToAtmosphere ? 'atm' : downEntity}`,
            fluid: selectedFluid,
            commandedDurationSec,
            baselineMs,
            spikeDeltaPsi,
            baselineDownPsi: lastBaselinePsi,
            spikeTimeSec: lastSpikeSec,
            flowWindowSamples: lastTimedWindow,
            allSamples: lastRunSamples,
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `feed_pulse_${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const pulseBusy = pulsePhase !== 'idle';

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-auto p-3 gap-3">
      <div className="flex items-center gap-3 flex-shrink-0">
        <div className="w-1 h-5 bg-blue-500 rounded-full" />
        <h1 className="text-base font-bold text-blue-400 tracking-wider uppercase">
          Feed System Characterization
        </h1>
      </div>

      <p className="text-[10px] text-text-muted max-w-4xl leading-relaxed">
        Baselines the line with the valves shut, then hands the whole open-hold-close to the{' '}
        <em>sequencer</em>, which counts the window against a monotonic deadline. The window that is
        actually integrated is <em>flow start → flow stop</em> read off the trace — not the commanded
        hold: flow begins after the valve (line fill) and, with a catch tank, continues after it
        shuts (drain). CdA comes from ∫√ΔP dt over that window, so a decaying blowdown ΔP is handled
        exactly rather than averaged. Weigh the catch, enter the mass, Calculate. Model: incompressible
        ṁ = CdA√(2ρΔP) — right for water under GN2; a gas through the orifice needs compressible relations.
      </p>

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-3 flex-shrink-0">
        <div className="bg-card border border-gray-800 rounded-lg p-4 flex flex-col gap-3">
          <h2 className="text-xs font-bold text-text-muted uppercase tracking-widest border-b border-gray-800 pb-2">
            Timed pulse
          </h2>

          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-bold text-text-muted uppercase">Flow time (s)</label>
              <div className="bg-gray-950 border border-gray-800 rounded px-2 py-1.5 text-sm font-mono text-blue-400">
                {flowTime.toFixed(3)}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-bold text-text-muted uppercase">Mass (kg)</label>
              <input
                type="number"
                value={totalMass}
                onChange={(e) => setTotalMass(Number(e.target.value))}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm font-mono text-emerald-400"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 border border-gray-800 rounded p-2 bg-gray-950/40">
              <div className="flex flex-col gap-1">
                <label className="text-[9px] font-bold text-text-muted uppercase">Open duration (s)</label>
                <input
                  type="number"
                  step={0.05}
                  min={0.05}
                  max={maxHoldSec ?? undefined}
                  value={commandedDurationSec}
                  onChange={(e) => setCommandedDurationSec(Number(e.target.value))}
                  title={maxHoldSec ? `Config caps this at ${maxHoldSec} s` : undefined}
                  className={`bg-gray-900 border rounded px-2 py-1 text-xs font-mono ${maxHoldSec !== null && commandedDurationSec > maxHoldSec ? 'border-red-500 text-red-300' : 'border-gray-700'}`}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label
                  className="text-[9px] font-bold text-text-muted uppercase"
                  title="With the valves still shut, sample both PTs for this long and take the median of each. That median is the zero the flow-start and flow-stop thresholds are measured from — and it is also the check that the PTs are streaming at all before anything opens."
                >Zero window (ms)</label>
                <input
                  type="number"
                  min={100}
                  step={50}
                  value={baselineMs}
                  onChange={(e) => setBaselineMs(Number(e.target.value))}
                  className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs font-mono"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] font-bold text-text-muted uppercase">Spike Δ (PSI)</label>
                <input
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={spikeDeltaPsi}
                  onChange={(e) => setSpikeDeltaPsi(Number(e.target.value))}
                  className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs font-mono"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] font-bold text-text-muted uppercase">Spike timeout (ms)</label>
                <input
                  type="number"
                  min={1000}
                  step={1000}
                  value={spikeTimeoutMs}
                  onChange={(e) => setSpikeTimeoutMs(Number(e.target.value))}
                  className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs font-mono"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] font-bold text-text-muted uppercase">Drain (ms)</label>
                <input
                  type="number"
                  min={0}
                  step={250}
                  value={drainTimeoutMs}
                  onChange={(e) => setDrainTimeoutMs(Number(e.target.value))}
                  title="How long to keep following the trace after the valve shuts, waiting for flow to stop. The line drains into the catch after close and that mass is on the scale."
                  className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs font-mono"
                />
              </div>
            </div>

          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-bold text-text-muted uppercase">Upstream PT</label>
            <select
              value={upEntity}
              onChange={(e) => setUpEntity(e.target.value)}
              disabled={pulseBusy}
              className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm"
            >
              {ptSensors.length === 0 && <option value="">— no PTs configured —</option>}
              {ptSensors.map((x) => (
                <option key={x.calEntity} value={x.calEntity}>{x.role || x.calEntity}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-bold text-text-muted uppercase">Downstream</label>
            <select
              value={downEntity}
              onChange={(e) => setDownEntity(e.target.value)}
              disabled={pulseBusy}
              className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm"
            >
              <option value={ATMOSPHERE}>Atmosphere (0 psig)</option>
              {ptSensors.map((x) => (
                <option key={x.calEntity} value={x.calEntity}>{x.role || x.calEntity}</option>
              ))}
            </select>
            <p className="text-[9px] text-gray-500 leading-snug">
              {ventToAtmosphere
                ? 'ΔP = upstream gauge. Flow start is detected from upstream drooping.'
                : 'ΔP = upstream − downstream. Flow start is detected from downstream rising.'}
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-bold text-text-muted uppercase">Fluid</label>
            <select
              value={selectedFluid}
              onChange={(e) => {
                setSelectedFluid(e.target.value);
                if (e.target.value !== 'Custom') {
                  setCustomDensity(FLUID_PROPERTIES[e.target.value].density);
                  setCustomViscosity(FLUID_PROPERTIES[e.target.value].viscosity);
                }
              }}
              className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm"
            >
              {Object.keys(FLUID_PROPERTIES).map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>

          {selectedFluid === 'Custom' && (
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-text-muted">ρ (kg/m³)</label>
                <input
                  type="number"
                  value={customDensity}
                  onChange={(e) => setCustomDensity(Number(e.target.value))}
                  className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-text-muted">μ (Pa·s)</label>
                <input
                  type="number"
                  value={customViscosity}
                  onChange={(e) => setCustomViscosity(Number(e.target.value))}
                  className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs"
                />
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <label
              className="text-[10px] font-bold text-text-muted uppercase"
              title="Feeds the Reynolds number only: Re = 4ṁ/(πDμ). Use the orifice/throat diameter — Cd correlates against orifice Reynolds, which is what the Re vs CdA plot is for. Enter the line ID instead if you want line Reynolds; the formula is the same, only the meaning changes."
            >Orifice Ø (m)</label>
            <input
              type="number"
              value={diameter}
              onChange={(e) => setDiameter(Number(e.target.value))}
              className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm"
            />
          </div>
        </div>

        <div className="bg-card border border-gray-800 rounded-lg p-4 flex flex-col gap-3">
          <h2 className="text-xs font-bold text-text-muted uppercase tracking-widest border-b border-gray-800 pb-2">
            Capture
          </h2>
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-gray-900/50 rounded p-2 border border-gray-800/50 text-center">
              <div className="text-[10px] font-bold text-text-muted uppercase mb-1">Upstream</div>
              <div className="text-lg font-mono font-bold text-blue-400">
                {currentUpVal?.toFixed(1) ?? '---'}
              </div>
            </div>
            <div className="bg-gray-900/50 rounded p-2 border border-gray-800/50 text-center">
              <div className="text-[10px] font-bold text-text-muted uppercase mb-1">Downstream</div>
              <div className="text-lg font-mono font-bold text-indigo-400">
                {currentDownVal?.toFixed(1) ?? '---'}
              </div>
            </div>
          </div>
          <div className="bg-blue-900/10 rounded-lg p-2 border border-blue-900/30 text-center">
            <div className="text-[10px] font-bold text-blue-400 uppercase">ΔP</div>
            <div className="text-2xl font-mono font-bold text-blue-300">{liveDeltaP?.toFixed(2) ?? '---'}</div>
          </div>

          <div className="flex flex-col gap-2">
              {flowState === null && (
                <p className="text-[10px] text-red-200 leading-snug border border-red-900/50 rounded p-2 bg-red-950/30">
                  No state is marked as the flow state, so there is nothing to hold. Tick{' '}
                  <strong>Flow</strong> on a state in Config → States, and set its return state and
                  duration under Config → Flow test.
                </p>
              )}
              {flowState !== null && !canHold && (
                <div className="text-[10px] text-amber-200 leading-snug border border-amber-900/50 rounded p-2 bg-amber-950/30 flex flex-col gap-2">
                  <span>
                    Control is not armed, so the backend will reject the command. Debug mode is
                    <strong> not</strong> needed — this is an ordinary state transition, allowed by
                    the transition matrix.
                  </span>
                  <button
                    type="button"
                    onClick={unlock}
                    className="bg-amber-600 hover:bg-amber-500 text-black font-bold py-1.5 rounded uppercase text-[10px]"
                  >
                    Arm control
                  </button>
                </div>
              )}
              {saveError && (
                <p className="text-[10px] text-amber-200 leading-snug border border-amber-900/50 rounded p-2 bg-amber-950/30">
                  Result shown below but NOT saved with the run: {saveError}
                </p>
              )}
              {pulseError && (
                <p className="text-[10px] text-red-200 leading-snug border border-red-900/50 rounded p-2 bg-red-950/30">
                  Sequencer: {pulseError}
                </p>
              )}
              <button
                type="button"
                onClick={() => void runTimedPulse()}
                disabled={pulseBusy || flowState === null || !canHold}
                title={flowState !== null ? `Holds ${stateName(flowState)} for exactly this long` : undefined}
                className="w-full bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-black font-black py-3 rounded-xl uppercase text-xs"
              >
                {pulseBusy ? pulsePhase.replace('_', ' ') : 'Run timed pulse'}
              </button>
              {flowState !== null && (
                <p className="text-[9px] text-gray-500">
                  Held by the sequencer in <span className="font-mono">{stateName(flowState)}</span>
                  {currentState === flowState && <span className="text-amber-400 font-bold"> · HOLDING</span>}
                </p>
              )}
              {pulseBusy && (
                <button
                  type="button"
                  onClick={cancelPulse}
                  className="w-full bg-gray-800 hover:bg-gray-700 text-white font-bold py-2 rounded-lg text-xs uppercase"
                >
                  Cancel & close
                </button>
              )}
              {pulseStatus && (
                <p className="text-[10px] text-amber-200/90 leading-snug border border-amber-900/40 rounded p-2 bg-amber-950/20">
                  {pulseStatus}
                </p>
              )}
              {lastBaselinePsi != null && (
                <p className="text-[9px] text-gray-500 font-mono">
                  Last baseline P<sub>down</sub>: {lastBaselinePsi.toFixed(2)} PSI
                  {lastSpikeSec != null && ` · spike t: ${lastSpikeSec.toFixed(3)} s`}
                  {lastTimedWindow.length > 0 && ` · ${lastTimedWindow.length} pts in flow window`}
                </p>
              )}
          </div>

          <button
            type="button"
            onClick={calculateCdA}
            disabled={flowTime <= 0 || totalMass <= 0 || lastTimedWindow.length === 0}
            className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-black font-bold py-2 rounded-lg uppercase text-xs"
          >
            Calculate CdA / Re
          </button>
          <button
            type="button"
            onClick={exportLastRunJson}
            disabled={lastRunSamples.length === 0}
            className="w-full bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-[10px] font-bold py-2 rounded uppercase border border-gray-600"
          >
            Export last pulse JSON
          </button>
        </div>

        <div className="bg-card border border-gray-800 rounded-lg p-4 flex flex-col xl:col-span-2">
          <h2 className="text-xs font-bold text-text-muted uppercase tracking-widest border-b border-gray-800 pb-2 mb-2">
            Latest run quality
          </h2>
          {results.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-[11px]">
              <div>
                <div className="text-text-muted uppercase text-[9px]">ṁ</div>
                <div className="font-mono text-lg text-white">{results[results.length - 1].mdot.toFixed(4)} kg/s</div>
              </div>
              <div>
                <div className="text-text-muted uppercase text-[9px]">CdA</div>
                <div className="font-mono text-lg text-emerald-400">
                  {results[results.length - 1].cda.toExponential(3)} m²
                </div>
              </div>
              <div>
                <div className="text-text-muted uppercase text-[9px]">Re</div>
                <div className="font-mono text-lg text-amber-400">
                  {results[results.length - 1].re.toExponential(2)}
                </div>
              </div>
              <div>
                <div className="text-text-muted uppercase text-[9px]">σ(ΔP)</div>
                <div className="font-mono text-white">
                  {results[results.length - 1].stdevDeltaPsi?.toFixed(3) ?? '—'} PSI
                </div>
              </div>
              <div>
                <div className="text-text-muted uppercase text-[9px]">CV(ΔP)</div>
                <div className="font-mono text-white">
                  {results[results.length - 1].cvDeltaPPercent?.toFixed(2) ?? '—'} %
                </div>
              </div>
              <div>
                <div className="text-text-muted uppercase text-[9px]">Mode</div>
                <div className="font-mono text-gray-300">{results[results.length - 1].mode}</div>
              </div>
              <button
                type="button"
                onClick={exportCsv}
                className="col-span-full mt-2 bg-gray-800 hover:bg-gray-700 text-xs font-bold py-2 rounded uppercase border border-gray-600"
              >
                Export CSV ({results.length} runs)
              </button>
            </div>
          ) : (
            <div className="text-gray-600 italic text-sm">Run a test and calculate to see quality metrics.</div>
          )}

          {deltaPChartData.length > 0 && (
            <div className="mt-3 h-40 min-h-[160px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={deltaPChartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                  <XAxis dataKey="t" stroke="#888" fontSize={9} tickFormatter={(v) => `${v}s`} />
                  <YAxis stroke="#888" fontSize={9} />
                  <Tooltip contentStyle={{ backgroundColor: '#111', border: '1px solid #333', fontSize: 10 }} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  {/* The window that was actually integrated. Shown because the number depends
                      entirely on it: if this band does not cover the flow and only the flow, the
                      CdA is wrong no matter how exact the valve timing was. */}
                  {lastFlowWindow && (
                    <ReferenceArea
                      x1={lastFlowWindow.startSec}
                      x2={lastFlowWindow.endSec}
                      fill="#22c55e"
                      fillOpacity={0.12}
                      stroke="#22c55e"
                      strokeOpacity={0.4}
                    />
                  )}
                  <Line type="monotone" dataKey="deltaP" name="ΔP (PSI)" stroke="#38bdf8" dot={false} strokeWidth={2} />
                  {!ventToAtmosphere && (
                    <Line type="monotone" dataKey="down" name="P down" stroke="#a78bfa" dot={false} strokeWidth={1} />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 min-h-[200px] flex-1">
        <div className="bg-card border border-gray-800 rounded-lg p-2 flex flex-col min-w-0 min-h-[200px]">
          <h3 className="text-[10px] font-bold text-text-muted uppercase px-2 pt-1">Live pressures (PSI)</h3>
          <div className="flex-1 min-h-[180px]">
            <TimeSeriesPlot
              title="Feed pressures"
              // Only real streams: with the orifice venting to air there is no downstream PT to
              // plot, and charting a constant zero would just be a lie with a line through it.
              entities={ventToAtmosphere ? [upEntity] : [upEntity, downEntity]}
              component="pressure_psi"
              colors={
                ventToAtmosphere
                  ? [getEntityColor(upEntity)]
                  : [getEntityColor(upEntity), getEntityColor(downEntity)]
              }
              height={180}
            />
          </div>
        </div>

        <div className="bg-card border border-gray-800 rounded-lg p-2 flex flex-col min-w-0 min-h-[200px]">
          <h3 className="text-[10px] font-bold text-text-muted uppercase px-2 pt-1">CdA vs ṁ</h3>
          <div className="flex-1 min-h-0">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis type="number" dataKey="mdot" name="ṁ" stroke="#888" fontSize={10}>
                  <Label value="ṁ (kg/s)" position="bottom" offset={0} fill="#888" fontSize={10} />
                </XAxis>
                <YAxis type="number" dataKey="cda" name="CdA" stroke="#888" fontSize={10}>
                  <Label value="CdA (m²)" angle={-90} position="left" offset={-10} fill="#888" fontSize={10} />
                </YAxis>
                <Tooltip
                  cursor={{ strokeDasharray: '3 3' }}
                  contentStyle={{ backgroundColor: '#111', border: '1px solid #333', fontSize: '10px' }}
                />
                <Scatter name="Tests" data={results} fill="#34d399" />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-card border border-gray-800 rounded-lg p-2 flex flex-col min-w-0 min-h-[200px]">
          <h3 className="text-[10px] font-bold text-text-muted uppercase px-2 pt-1">Re vs CdA</h3>
          <div className="flex-1 min-h-0">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis type="number" dataKey="re" name="Re" stroke="#888" fontSize={10} domain={['auto', 'auto']}>
                  <Label value="Reynolds" position="bottom" offset={0} fill="#888" fontSize={10} />
                </XAxis>
                <YAxis type="number" dataKey="cda" name="CdA" stroke="#888" fontSize={10}>
                  <Label value="CdA (m²)" angle={-90} position="left" offset={-10} fill="#888" fontSize={10} />
                </YAxis>
                <Tooltip
                  cursor={{ strokeDasharray: '3 3' }}
                  contentStyle={{ backgroundColor: '#111', border: '1px solid #333', fontSize: '10px' }}
                />
                <Scatter name="Tests" data={results} fill="#fbbf24" />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-card border border-gray-800 rounded-lg p-2 flex flex-col min-w-0 min-h-[200px]">
          <h3 className="text-[10px] font-bold text-text-muted uppercase px-2 pt-1">ΔP vs ṁ (run comparison)</h3>
          <div className="flex-1 min-h-0">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis type="number" dataKey="mdot" stroke="#888" fontSize={10}>
                  <Label value="ṁ (kg/s)" position="bottom" offset={0} fill="#888" fontSize={10} />
                </XAxis>
                <YAxis type="number" dataKey="deltaP" stroke="#888" fontSize={10}>
                  <Label value="ΔP (PSI)" angle={-90} position="left" offset={-10} fill="#888" fontSize={10} />
                </YAxis>
                <Tooltip contentStyle={{ backgroundColor: '#111', border: '1px solid #333', fontSize: '10px' }} />
                <Scatter name="Runs" data={results} fill="#f472b6" />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="h-36 bg-card border border-gray-800 rounded-lg overflow-hidden flex flex-col flex-shrink-0">
        <div className="bg-gray-900 border-b border-gray-800 px-3 py-1 flex justify-between items-center">
          <span className="text-[10px] font-black text-text-muted uppercase">Run history</span>
          <span className="text-[9px] text-gray-500 font-mono">{results.length} runs</span>
        </div>
        <div className="flex-1 overflow-auto">
          <table className="w-full text-[10px] text-left border-collapse">
            <thead className="bg-gray-900/50 sticky top-0">
              <tr className="border-b border-gray-800 text-text-muted">
                <th className="px-2 py-1 font-bold">Time</th>
                <th className="px-2 py-1 font-bold">Mode</th>
                <th className="px-2 py-1 font-bold">Sys</th>
                <th className="px-2 py-1 font-bold">ṁ</th>
                <th className="px-2 py-1 font-bold">ΔP</th>
                <th className="px-2 py-1 font-bold">σΔP</th>
                <th className="px-2 py-1 font-bold">CdA</th>
                <th className="px-2 py-1 font-bold">Re</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/40">
              {results
                .slice()
                .reverse()
                .map((r) => (
                  <tr key={r.id} className="hover:bg-white/[0.02]">
                    <td className="px-2 py-1 font-mono">{r.timestamp}</td>
                    <td className="px-2 py-1">{r.mode}</td>
                    <td className="px-2 py-1">
                      {r.system} ({r.fluid})
                    </td>
                    <td className="px-2 py-1 font-mono">{r.mdot.toFixed(3)}</td>
                    <td className="px-2 py-1 font-mono">{r.deltaP.toFixed(1)}</td>
                    <td className="px-2 py-1 font-mono">{r.stdevDeltaPsi?.toFixed(2) ?? '—'}</td>
                    <td className="px-2 py-1 font-mono text-emerald-400">{r.cda.toExponential(3)}</td>
                    <td className="px-2 py-1 font-mono text-amber-400">{r.re.toExponential(2)}</td>
                  </tr>
                ))}
              {results.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-4 text-center text-gray-600 italic">
                    No data recorded.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
