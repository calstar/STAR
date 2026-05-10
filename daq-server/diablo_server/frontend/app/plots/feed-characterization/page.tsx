'use client'

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { getEntityColor } from '@/lib/sensor-colors';
import { getWebSocketClient } from '@/lib/websocket';
import { ActuatorState } from '@/lib/types';
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
} from 'recharts';
import {
  type PressureSample,
  median,
  mean,
  sampleStdev,
  coefficientOfVariationPercent,
  computeCdAIncompressible,
  reynoldsPipe,
  sliceSamplesByTime,
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

const SYSTEMS = [
  { label: 'Fuel', up: 'PT_Cal.Fuel_Upstream', down: 'PT_Cal.Fuel_Downstream' },
  { label: 'LOX', up: 'PT_Cal.Ox_Upstream', down: 'PT_Cal.Ox_Downstream' },
  { label: 'COPV', up: 'PT_Cal.GN2_High', down: 'PT_Cal.GN2_Regulated' },
] as const;

type PulsePhase = 'idle' | 'baselining' | 'wait_spike' | 'flowing';

export default function FeedCharacterizationPage() {
  const [flowTime, setFlowTime] = useState<number>(1);
  const [totalMass, setTotalMass] = useState<number>(0.5);
  const [selectedSystemLabel, setSelectedSystemLabel] = useState<string>('Fuel');
  const [selectedFluid, setSelectedFluid] = useState<string>('Kerosene');
  const [customDensity, setCustomDensity] = useState<number>(FLUID_PROPERTIES['Kerosene'].density);
  const [customViscosity, setCustomViscosity] = useState<number>(FLUID_PROPERTIES['Kerosene'].viscosity);
  const [diameter, setDiameter] = useState<number>(0.0254);

  const [testMode, setTestMode] = useState<'manual' | 'timed_spike'>('manual');
  const [commandedDurationSec, setCommandedDurationSec] = useState(1);
  const [baselineMs, setBaselineMs] = useState(400);
  const [spikeDeltaPsi, setSpikeDeltaPsi] = useState(5);
  const [spikeTimeoutMs, setSpikeTimeoutMs] = useState(15000);

  const [isTestRunning, setIsTestRunning] = useState(false);
  const [testStartTime, setTestStartTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState<number>(0);
  const [accumulatedPUp, setAccumulatedPUp] = useState<number[]>([]);
  const [accumulatedPDown, setAccumulatedPDown] = useState<number[]>([]);
  const [results, setResults] = useState<CharacterizationResult[]>([]);

  const [pulsePhase, setPulsePhase] = useState<PulsePhase>('idle');
  const pulseAbortRef = useRef(false);
  const pulseInFlightRef = useRef(false);
  const pulseSamplesRef = useRef<PressureSample[]>([]);
  const [lastRunSamples, setLastRunSamples] = useState<PressureSample[]>([]);
  const [lastTimedWindow, setLastTimedWindow] = useState<PressureSample[]>([]);
  const [lastBaselinePsi, setLastBaselinePsi] = useState<number | null>(null);
  const [lastSpikeSec, setLastSpikeSec] = useState<number | null>(null);
  const [pulseStatus, setPulseStatus] = useState('');

  const ws = getWebSocketClient();
  const selectedSystem = SYSTEMS.find((s) => s.label === selectedSystemLabel) || SYSTEMS[0];
  const currentUpVal = useSensorStore((s) => s.getSensorValue(selectedSystem.up, 'pressure_psi'));
  const currentDownVal = useSensorStore((s) => s.getSensorValue(selectedSystem.down, 'pressure_psi'));

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

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isTestRunning && testStartTime) {
      interval = setInterval(() => {
        setElapsedTime((Date.now() - testStartTime) / 1000);
      }, 50);
    }
    return () => clearInterval(interval);
  }, [isTestRunning, testStartTime]);

  useEffect(() => {
    if (isTestRunning && currentUpVal !== null && currentDownVal !== null) {
      setAccumulatedPUp((prev) => [...prev, currentUpVal]);
      setAccumulatedPDown((prev) => [...prev, currentDownVal]);
    }
  }, [isTestRunning, currentUpVal, currentDownVal]);

  const getActuatorNames = useCallback((): string[] => {
    if (selectedSystemLabel === 'Fuel') return ['Fuel Main'];
    if (selectedSystemLabel === 'LOX') return ['LOX Main'];
    if (selectedSystemLabel === 'COPV') return ['Fuel Press', 'LOX Press'];
    return [];
  }, [selectedSystemLabel]);

  const toggleSolenoids = useCallback(
    (state: ActuatorState) => {
      getActuatorNames().forEach((name) => {
        ws.sendCommand({
          commandType: 'actuator',
          data: {
            actuatorName: name,
            actuatorState: state,
          },
        });
      });
    },
    [getActuatorNames, ws],
  );

  const sampleNow = useCallback(
    (wall0: number): PressureSample => ({
      tSec: (Date.now() - wall0) / 1000,
      upPsi: useSensorStore.getState().getSensorValue(selectedSystem.up, 'pressure_psi'),
      downPsi: useSensorStore.getState().getSensorValue(selectedSystem.down, 'pressure_psi'),
    }),
    [selectedSystem.down, selectedSystem.up],
  );

  const runTimedPulse = useCallback(async () => {
    if (pulsePhase !== 'idle') return;
    pulseAbortRef.current = false;
    pulseSamplesRef.current = [];
    const wall0 = Date.now();
    setPulsePhase('baselining');
    setPulseStatus('Baselining downstream (valves closed)…');
    setLastTimedWindow([]);
    setLastSpikeSec(null);

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    try {
      const baselineDown: number[] = [];
      const bDeadline = Date.now() + baselineMs;
      while (Date.now() < bDeadline) {
        if (pulseAbortRef.current) throw new Error('aborted');
        const s = sampleNow(wall0);
        pulseSamplesRef.current.push(s);
        if (s.downPsi != null) baselineDown.push(s.downPsi);
        await sleep(40);
      }
      const baselinePsi = median(baselineDown.filter(Number.isFinite));
      if (!Number.isFinite(baselinePsi)) throw new Error('No downstream baseline');
      setLastBaselinePsi(baselinePsi);

      setPulsePhase('wait_spike');
      setPulseStatus('Opening valves — waiting for downstream spike (flow start)…');
      toggleSolenoids(ActuatorState.OPEN);

      const waitDeadline = Date.now() + spikeTimeoutMs;
      let tSpikeSec: number | null = null;
      while (Date.now() < waitDeadline) {
        if (pulseAbortRef.current) throw new Error('aborted');
        await sleep(25);
        const s = sampleNow(wall0);
        pulseSamplesRef.current.push(s);
        const d = s.downPsi;
        if (d != null && Number.isFinite(d) && d >= baselinePsi + spikeDeltaPsi) {
          tSpikeSec = s.tSec;
          setLastSpikeSec(tSpikeSec);
          break;
        }
      }
      if (tSpikeSec == null) {
        setPulseStatus('Timeout — no spike. Valves closed.');
        toggleSolenoids(ActuatorState.CLOSED);
        setLastRunSamples([...pulseSamplesRef.current]);
        setPulsePhase('idle');
        return;
      }

      setPulsePhase('flowing');
      setPulseStatus(`Flowing ${commandedDurationSec.toFixed(2)} s from spike…`);
      const flowEndWall = Date.now() + commandedDurationSec * 1000;
      while (Date.now() < flowEndWall) {
        if (pulseAbortRef.current) break;
        await sleep(25);
        pulseSamplesRef.current.push(sampleNow(wall0));
      }

      toggleSolenoids(ActuatorState.CLOSED);
      const all = [...pulseSamplesRef.current];
      setLastRunSamples(all);
      const win = sliceSamplesByTime(all, tSpikeSec, tSpikeSec + commandedDurationSec);
      setLastTimedWindow(win);
      setFlowTime(commandedDurationSec);
      setPulseStatus(
        `Done. Spike at t=${tSpikeSec.toFixed(3)} s (run time). Weigh system, enter mass, then Calculate.`,
      );
    } catch {
      toggleSolenoids(ActuatorState.CLOSED);
      setPulseStatus('Aborted / error — valves closed.');
      setLastRunSamples([...pulseSamplesRef.current]);
    } finally {
      pulseInFlightRef.current = false;
      setPulsePhase('idle');
    }
  }, [baselineMs, commandedDurationSec, sampleNow, spikeDeltaPsi, spikeTimeoutMs, toggleSolenoids]);

  const cancelPulse = useCallback(() => {
    pulseAbortRef.current = true;
    toggleSolenoids(ActuatorState.CLOSED);
    setPulseStatus('Cancelling…');
  }, [toggleSolenoids]);

  const startTest = () => {
    if (pulsePhase !== 'idle') return;
    setAccumulatedPUp([]);
    setAccumulatedPDown([]);
    setElapsedTime(0);
    setTestStartTime(Date.now());
    setIsTestRunning(true);
    toggleSolenoids(ActuatorState.OPEN);
  };

  const stopTest = () => {
    setIsTestRunning(false);
    toggleSolenoids(ActuatorState.CLOSED);
    if (accumulatedPUp.length === 0 || accumulatedPDown.length === 0) return;
    setFlowTime(elapsedTime);
  };

  const calculateCdA = () => {
    let avgPUp: number;
    let avgPDown: number;
    let n: number;
    let mode: 'manual' | 'timed_spike' = 'manual';
    let baselineDownPsi: number | undefined;
    let spikeTimeSec: number | undefined;
    let stdevDeltaPsi: number | undefined;
    let cvDeltaPPercent: number | undefined;

    if (testMode === 'timed_spike' && lastTimedWindow.length > 0) {
      mode = 'timed_spike';
      const { avgUp, avgDown, n: nn } = averagePressures(lastTimedWindow);
      avgPUp = avgUp;
      avgPDown = avgDown;
      n = nn;
      baselineDownPsi = lastBaselinePsi ?? undefined;
      spikeTimeSec = lastSpikeSec ?? undefined;
      const dps = deltaPSeries(lastTimedWindow);
      stdevDeltaPsi = sampleStdev(dps);
      cvDeltaPPercent = coefficientOfVariationPercent(dps);
    } else {
      if (accumulatedPUp.length === 0 || accumulatedPDown.length === 0 || flowTime <= 0) return;
      avgPUp = mean(accumulatedPUp);
      avgPDown = mean(accumulatedPDown);
      n = Math.min(accumulatedPUp.length, accumulatedPDown.length);
      const dps = accumulatedPUp.map((u, i) => u - accumulatedPDown[i]!);
      stdevDeltaPsi = sampleStdev(dps);
      cvDeltaPPercent = coefficientOfVariationPercent(dps);
    }

    const deltaP_psi = avgPUp - avgPDown;
    const cd = computeCdAIncompressible({
      totalMassKg: totalMass,
      flowTimeSec: flowTime,
      avgDeltaPsi: deltaP_psi,
      densityKgM3: density,
    });
    if (!cd) return;

    const re = reynoldsPipe(cd.mdotKgS, diameter, viscosity);

    const newResult: CharacterizationResult = {
      id: Date.now(),
      timestamp: new Date().toLocaleTimeString(),
      system: selectedSystemLabel,
      fluid: selectedFluid,
      flowTime,
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
            system: selectedSystemLabel,
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
        <strong>Manual</strong>: open → stop when done; flow time = elapsed. <strong>Timed + spike</strong>:
        baselines downstream with valves closed, opens mains, uses <em>first downstream pressure rise</em>{' '}
        (vs baseline + Δ) as flow start, holds open for your duration, then closes — weigh after, enter mass,
        Calculate. Model: incompressible ṁ = CdA√(2ρΔP); for large ΔP/P use compressible nozzle methods.
      </p>

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-3 flex-shrink-0">
        <div className="bg-card border border-gray-800 rounded-lg p-4 flex flex-col gap-3">
          <h2 className="text-xs font-bold text-text-muted uppercase tracking-widest border-b border-gray-800 pb-2">
            Test mode
          </h2>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setTestMode('manual')}
              className={`flex-1 py-2 rounded text-[10px] font-bold uppercase ${
                testMode === 'manual' ? 'bg-blue-600 text-black' : 'bg-gray-800 text-gray-400'
              }`}
            >
              Manual window
            </button>
            <button
              type="button"
              onClick={() => setTestMode('timed_spike')}
              className={`flex-1 py-2 rounded text-[10px] font-bold uppercase ${
                testMode === 'timed_spike' ? 'bg-blue-600 text-black' : 'bg-gray-800 text-gray-400'
              }`}
            >
              Timed + spike
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-bold text-text-muted uppercase">Flow time (s)</label>
              <div className="bg-gray-950 border border-gray-800 rounded px-2 py-1.5 text-sm font-mono text-blue-400">
                {isTestRunning ? elapsedTime.toFixed(2) : flowTime.toFixed(3)}
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

          {testMode === 'timed_spike' && (
            <div className="grid grid-cols-2 gap-2 border border-gray-800 rounded p-2 bg-gray-950/40">
              <div className="flex flex-col gap-1">
                <label className="text-[9px] font-bold text-text-muted uppercase">Open duration (s)</label>
                <input
                  type="number"
                  step={0.05}
                  min={0.05}
                  value={commandedDurationSec}
                  onChange={(e) => setCommandedDurationSec(Number(e.target.value))}
                  className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs font-mono"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] font-bold text-text-muted uppercase">Baseline (ms)</label>
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
            </div>
          )}

          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-bold text-text-muted uppercase">System</label>
            <select
              value={selectedSystemLabel}
              onChange={(e) => setSelectedSystemLabel(e.target.value)}
              disabled={pulseBusy || isTestRunning}
              className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm"
            >
              {SYSTEMS.map((s) => (
                <option key={s.label} value={s.label}>
                  {s.label}
                </option>
              ))}
            </select>
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
            <label className="text-[10px] font-bold text-text-muted uppercase">Diameter (m)</label>
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

          {testMode === 'manual' && (
            <div className="flex flex-col gap-2">
              {!isTestRunning ? (
                <button
                  type="button"
                  onClick={startTest}
                  disabled={pulseBusy}
                  className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-black font-black py-3 rounded-xl uppercase text-xs"
                >
                  Start flow window
                </button>
              ) : (
                <button
                  type="button"
                  onClick={stopTest}
                  className="w-full bg-red-600 hover:bg-red-500 text-white font-black py-3 rounded-xl uppercase text-xs animate-pulse"
                >
                  Stop & capture time
                </button>
              )}
            </div>
          )}

          {testMode === 'timed_spike' && (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => void runTimedPulse()}
                disabled={pulseBusy || isTestRunning}
                className="w-full bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-black font-black py-3 rounded-xl uppercase text-xs"
              >
                {pulseBusy ? pulsePhase.replace('_', ' ') : 'Run timed pulse'}
              </button>
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
          )}

          <button
            type="button"
            onClick={calculateCdA}
            disabled={
              flowTime <= 0 ||
              totalMass <= 0 ||
              (testMode === 'timed_spike'
                ? lastTimedWindow.length === 0
                : accumulatedPUp.length === 0)
            }
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
                  <Line type="monotone" dataKey="deltaP" name="ΔP (PSI)" stroke="#38bdf8" dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="down" name="P down" stroke="#a78bfa" dot={false} strokeWidth={1} />
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
              entities={[selectedSystem.up, selectedSystem.down]}
              component="pressure_psi"
              colors={[getEntityColor(selectedSystem.up), getEntityColor(selectedSystem.down)]}
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
