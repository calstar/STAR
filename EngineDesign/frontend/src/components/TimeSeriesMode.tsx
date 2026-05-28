import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { PressureProfileForm } from './PressureProfileForm';
import { SegmentCurveBuilder } from './SegmentCurveBuilder';
import { PressureCurveChart } from './PressureCurveChart';
import { TankFillVisualizer } from './TankFillVisualizer';
import {
  generateTimeseries,
  generateFromSegments,
  uploadTimeseriesFromCSV,
  getConfig,
  type ProfileParams,
  type PressureSegment,
  type TimeSeriesData,
  type TimeSeriesSummary,
  type EngineConfig,
} from '../api/client';

interface TimeSeriesModeProps {
  config: EngineConfig | null;
  onConfigLoaded?: (config: EngineConfig) => void;
}

type InputMode = 'simple' | 'segments' | 'blowdown' | 'upload';

interface PwmSegment {
  id: number;
  startTime: string;   // s — when this PWM block begins
  frequency: string;   // Hz
  dutyCycle: string;   // percent, 0–100
  duration: string;    // s
}

// Default profile params
const defaultLoxProfile: ProfileParams = {
  start_pressure_psi: 750,
  end_pressure_psi: 500,
  profile_type: 'exponential',
  decay_constant: 3.0,
};

const defaultFuelProfile: ProfileParams = {
  start_pressure_psi: 600,
  end_pressure_psi: 400,
  profile_type: 'exponential',
  decay_constant: 3.0,
};

// Default segments for segment builder
const defaultLoxSegments: PressureSegment[] = [
  {
    length_ratio: 0.3,
    type: 'blowdown',
    start_pressure_psi: 750,
    end_pressure_psi: 650,
    k: 0.5,
  },
  {
    length_ratio: 0.4,
    type: 'blowdown',
    start_pressure_psi: 650,
    end_pressure_psi: 550,
    k: 0.7,
  },
  {
    length_ratio: 0.3,
    type: 'blowdown',
    start_pressure_psi: 550,
    end_pressure_psi: 500,
    k: 1.0,
  },
];

const defaultFuelSegments: PressureSegment[] = [
  {
    length_ratio: 0.3,
    type: 'blowdown',
    start_pressure_psi: 600,
    end_pressure_psi: 500,
    k: 0.5,
  },
  {
    length_ratio: 0.4,
    type: 'blowdown',
    start_pressure_psi: 500,
    end_pressure_psi: 450,
    k: 0.7,
  },
  {
    length_ratio: 0.3,
    type: 'blowdown',
    start_pressure_psi: 450,
    end_pressure_psi: 400,
    k: 1.0,
  },
];

// Session storage key
const TIMESERIES_RESULTS_KEY = 'timeseries_results';

interface StoredResults {
  data: TimeSeriesData;
  summary: TimeSeriesSummary;
  timestamp: number;
}

function saveResultsToSession(results: { data: TimeSeriesData; summary: TimeSeriesSummary }) {
  const stored: StoredResults = {
    ...results,
    timestamp: Date.now(),
  };
  sessionStorage.setItem(TIMESERIES_RESULTS_KEY, JSON.stringify(stored));
}

function loadResultsFromSession(): { data: TimeSeriesData; summary: TimeSeriesSummary } | null {
  try {
    const stored = sessionStorage.getItem(TIMESERIES_RESULTS_KEY);
    if (!stored) return null;
    const parsed: StoredResults = JSON.parse(stored);
    return { data: parsed.data, summary: parsed.summary };
  } catch {
    return null;
  }
}

/** Read tank pressures and burn duration from session config (YAML lox_tank / fuel_tank / thrust). */
function readTimeseriesDefaultsFromConfig(config: EngineConfig): {
  loxPsi?: number;
  fuelPsi?: number;
  durationS?: number;
} {
  const loxTank = config.lox_tank as Record<string, unknown> | undefined;
  const fuelTank = config.fuel_tank as Record<string, unknown> | undefined;
  const thrust = config.thrust as Record<string, unknown> | undefined;
  const dr = config.design_requirements as Record<string, unknown> | undefined;

  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  const loxPsi = num(loxTank?.initial_pressure_psi);
  const fuelPsi = num(fuelTank?.initial_pressure_psi);

  let durationS = num(thrust?.burn_time);
  if (durationS === undefined) durationS = num(dr?.target_burn_time);
  if (durationS === undefined) durationS = num(dr?.target_burn_time_s);

  return { loxPsi, fuelPsi, durationS };
}

function clamp01(n: number): number {
  return Math.min(Math.max(n, 0), 1);
}

/** Liquid volume [L] from current mass and full-tank mass for that fluid (same tank geometry). */
function liquidLitersFromMassAndCapacity(
  massKg: number,
  maxMassKg: number,
  volumeM3: number | null | undefined
): number | null {
  if (volumeM3 != null && volumeM3 > 0 && maxMassKg > 0) {
    return (massKg / maxMassKg) * volumeM3 * 1000;
  }
  return null;
}

/** Mass [kg] that gives liquidLiters [L] at stated full-tank capacity (same tank volume). */
function massFromLiquidLiters(
  liters: number,
  maxMassKg: number,
  volumeM3: number | null | undefined
): number {
  if (volumeM3 != null && volumeM3 > 0 && maxMassKg > 0) {
    const volL = volumeM3 * 1000;
    return Math.min(Math.max((liters / volL) * maxMassKg, 0), maxMassKg);
  }
  return 0;
}

function hasCdFit(config: EngineConfig | null): boolean {
  const d = config?.discharge as Record<string, unknown> | undefined;
  const fuel = d?.fuel as Record<string, unknown> | undefined;
  return fuel?.cda_fit_a != null;
}

/** Expand a list of PWM segments into (t_open, t_close) intervals for the API. */
function pwmToIntervals(segs: PwmSegment[]): { t_open: number; t_close: number }[] {
  return segs.flatMap(s => {
    const f = parseFloat(s.frequency);
    const d = parseFloat(s.dutyCycle) / 100;
    const dur = parseFloat(s.duration);
    const t0 = parseFloat(s.startTime);
    if (!Number.isFinite(f) || f <= 0 || !Number.isFinite(d) || d <= 0 || d > 1) return [];
    if (!Number.isFinite(dur) || dur <= 0 || !Number.isFinite(t0)) return [];
    const period = 1 / f;
    const openDt = period * d;
    const out: { t_open: number; t_close: number }[] = [];
    for (let t = t0; t + openDt <= t0 + dur + 1e-9; t += period) {
      out.push({ t_open: t, t_close: Math.min(t + openDt, t0 + dur) });
    }
    return out;
  });
}

/** Mini SVG timeline showing a few PWM pulses. */
function PwmPreview({ frequency, dutyCycle, accentColor }: { frequency: string; dutyCycle: string; accentColor: string }) {
  const f = parseFloat(frequency);
  const d = parseFloat(dutyCycle) / 100;
  if (!Number.isFinite(f) || f <= 0 || !Number.isFinite(d) || d <= 0) {
    return <div style={{ width: 120, height: 20, background: 'rgba(255,255,255,0.04)', borderRadius: 3 }} />;
  }
  const showCycles = Math.min(Math.ceil(f * 2), 6); // ~2s worth, max 6 cycles
  const rects: React.ReactElement[] = [];
  const w = 120, h = 20;
  const cycleW = w / showCycles;
  const openW = cycleW * d;
  for (let i = 0; i < showCycles; i++) {
    const x = i * cycleW;
    rects.push(
      <rect key={`o${i}`} x={x} y={2} width={openW} height={h - 4} fill={accentColor} opacity={0.85} rx={1} />,
      <rect key={`c${i}`} x={x + openW} y={2} width={cycleW - openW} height={h - 4} fill="rgba(255,255,255,0.06)" rx={1} />,
    );
  }
  return (
    <svg width={w} height={h} style={{ borderRadius: 3, overflow: 'hidden', flexShrink: 0 }}>
      {rects}
    </svg>
  );
}

function PwmEditor({
  label,
  segments,
  onChange,
  accentColor = '#60a5fa',
}: {
  label: string;
  segments: PwmSegment[];
  onChange: (segs: PwmSegment[]) => void;
  accentColor?: string;
}) {
  function addSeg() {
    onChange([...segments, { id: Date.now(), startTime: '0', frequency: '1', dutyCycle: '50', duration: '5' }]);
  }
  function removeSeg(id: number) { onChange(segments.filter(s => s.id !== id)); }
  function update(id: number, field: keyof PwmSegment, val: string) {
    onChange(segments.map(s => s.id === id ? { ...s, [field]: val } : s));
  }

  // Summary: total pulse count + total open time
  const allIntervals = pwmToIntervals(segments);
  const totalOpen = allIntervals.reduce((acc, i) => acc + (i.t_close - i.t_open), 0);

  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: 'var(--color-bg-primary)',
    border: '1px solid var(--color-border)',
    borderRadius: 4,
    color: 'var(--color-text-primary)',
    padding: '3px 6px',
    fontSize: 11,
    fontFamily: 'ui-monospace, monospace',
    outline: 'none',
  };

  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: accentColor, marginBottom: 8 }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {segments.map(seg => {
          const f = parseFloat(seg.frequency);
          const d = parseFloat(seg.dutyCycle) / 100;
          const dur = parseFloat(seg.duration);
          const t0 = parseFloat(seg.startTime);
          const pulseCount = (Number.isFinite(f) && f > 0 && Number.isFinite(d) && d > 0 && Number.isFinite(dur) && dur > 0)
            ? Math.floor(dur * f * d / d) // = floor(dur * f)
            : null;
          const openTime = (pulseCount != null && Number.isFinite(d))
            ? (dur * d).toFixed(2)
            : null;
          return (
            <div
              key={seg.id}
              style={{
                background: 'var(--color-bg-primary)',
                border: `1px solid ${accentColor}33`,
                borderLeft: `3px solid ${accentColor}`,
                borderRadius: 6,
                padding: '8px 10px',
              }}
            >
              {/* Row 1: fields */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8, marginBottom: 6 }}>
                <div>
                  <div style={{ fontSize: 9, color: 'var(--color-text-secondary)', marginBottom: 2, letterSpacing: '0.05em' }}>START [s]</div>
                  <input type="number" step="0.1" value={seg.startTime} onChange={e => update(seg.id, 'startTime', e.target.value)} style={inputStyle} />
                </div>
                <div>
                  <div style={{ fontSize: 9, color: 'var(--color-text-secondary)', marginBottom: 2, letterSpacing: '0.05em' }}>FREQ [Hz]</div>
                  <input type="number" step="0.1" min="0.01" value={seg.frequency} onChange={e => update(seg.id, 'frequency', e.target.value)} style={inputStyle} />
                </div>
                <div>
                  <div style={{ fontSize: 9, color: 'var(--color-text-secondary)', marginBottom: 2, letterSpacing: '0.05em' }}>DUTY [%]</div>
                  <input type="number" step="1" min="1" max="99" value={seg.dutyCycle} onChange={e => update(seg.id, 'dutyCycle', e.target.value)} style={inputStyle} />
                </div>
                <div>
                  <div style={{ fontSize: 9, color: 'var(--color-text-secondary)', marginBottom: 2, letterSpacing: '0.05em' }}>DURATION [s]</div>
                  <input type="number" step="0.1" min="0" value={seg.duration} onChange={e => update(seg.id, 'duration', e.target.value)} style={inputStyle} />
                </div>
              </div>
              {/* Row 2: preview + summary + delete */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <PwmPreview frequency={seg.frequency} dutyCycle={seg.dutyCycle} accentColor={accentColor} />
                <div style={{ flex: 1, fontSize: 10, color: 'var(--color-text-secondary)' }}>
                  {pulseCount != null
                    ? <>
                        <span style={{ color: accentColor }}>{pulseCount} pulses</span>
                        {' · '}
                        {Number.isFinite(t0) ? `t = ${t0}–${(t0 + (parseFloat(seg.duration) || 0)).toFixed(1)}s` : ''}
                        {' · '}
                        {openTime}s open
                      </>
                    : <span style={{ opacity: 0.5 }}>fill in fields above</span>
                  }
                </div>
                <button
                  onClick={() => removeSeg(seg.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.3)', fontSize: 14, padding: '0 4px', flexShrink: 0 }}
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          onClick={addSeg}
          style={{ fontSize: 11, background: 'none', border: 'none', cursor: 'pointer', color: accentColor, padding: 0 }}
        >
          + Add PWM segment
        </button>
        {allIntervals.length > 0 && (
          <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
            Total: {allIntervals.length} pulses · {totalOpen.toFixed(2)}s open
          </span>
        )}
      </div>
    </div>
  );
}

export function TimeSeriesMode({ config, onConfigLoaded }: TimeSeriesModeProps) {
  // Mode selection
  const [inputMode, setInputMode] = useState<InputMode>('simple');

  // Simple profile state
  const [duration, setDuration] = useState(5.0);
  const [nSteps, setNSteps] = useState(101);
  const [loxProfile, setLoxProfile] = useState<ProfileParams>(defaultLoxProfile);
  const [fuelProfile, setFuelProfile] = useState<ProfileParams>(defaultFuelProfile);

  // Segment builder state
  const [segmentDuration, setSegmentDuration] = useState(5.0);
  const [nPoints, setNPoints] = useState(200);
  const [segmentDurationInput, setSegmentDurationInput] = useState('5.0');
  const [nPointsInput, setNPointsInput] = useState('200');
  const [loxSegments, setLoxSegments] = useState<PressureSegment[]>(defaultLoxSegments);
  const [fuelSegments, setFuelSegments] = useState<PressureSegment[]>(defaultFuelSegments);

  // Blowdown mode state
  const [loxInitialPressure, setLoxInitialPressure] = useState(750);
  const [fuelInitialPressure, setFuelInitialPressure] = useState(600);
  const [testType, setTestType] = useState<'hotfire' | 'waterflow'>('hotfire');
  const [loxPwmSegments, setLoxPwmSegments] = useState<PwmSegment[]>([]);
  const [fuelPwmSegments, setFuelPwmSegments] = useState<PwmSegment[]>([]);
  const [showSolenoidSchedule, setShowSolenoidSchedule] = useState(false);

  // ---- Tank capacity: derived directly from config (always up-to-date, never 0 if config is loaded) ----
  const tankCapacities = useMemo(() => {
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

    const loxTank = config?.['lox_tank'] as Record<string, unknown> | null | undefined;
    const fuelTank = config?.['fuel_tank'] as Record<string, unknown> | null | undefined;
    const fluids = config?.['fluids'] as Record<string, unknown> | null | undefined;
    const oxFluid = fluids?.['oxidizer'] as Record<string, unknown> | null | undefined;
    const fuelFluid = fluids?.['fuel'] as Record<string, unknown> | null | undefined;

    const oxDensity = num(oxFluid?.['density']);
    const fuelDensity = num(fuelFluid?.['density']);

    const loxVol =
      num(loxTank?.['tank_volume_m3']) ??
      (num(loxTank?.['lox_h']) !== null && num(loxTank?.['lox_radius']) !== null
        ? Math.PI * (num(loxTank!['lox_radius'])!) ** 2 * (num(loxTank!['lox_h'])!)
        : null);
    const fuelVol =
      num(fuelTank?.['tank_volume_m3']) ??
      (num(fuelTank?.['rp1_h']) !== null && num(fuelTank?.['rp1_radius']) !== null
        ? Math.PI * (num(fuelTank!['rp1_radius'])!) ** 2 * (num(fuelTank!['rp1_h'])!)
        : null);

    const loxConfigMass = num(loxTank?.['mass']);
    const fuelConfigMass = num(fuelTank?.['mass']);

    const loxRadiusM = num(loxTank?.['lox_radius']);
    const loxHeightM = num(loxTank?.['lox_h']);
    const fuelRadiusM = num(fuelTank?.['rp1_radius']);
    const fuelHeightM = num(fuelTank?.['rp1_h']);

    const loxMax = loxVol !== null && oxDensity !== null ? loxVol * oxDensity : 0;
    const fuelMax = fuelVol !== null && fuelDensity !== null ? fuelVol * fuelDensity : 0;
    const loxWaterMax = loxVol !== null ? loxVol * 1000 : 0;
    const fuelWaterMax = fuelVol !== null ? fuelVol * 1000 : 0;

    // Default initial masses: use config value, else 80% of max, else 0
    const loxDefault = loxConfigMass ?? (loxMax > 0 ? loxMax * 0.8 : 0);
    const fuelDefault = fuelConfigMass ?? (fuelMax > 0 ? fuelMax * 0.8 : 0);
    const loxWaterDefault = loxWaterMax > 0 ? loxWaterMax * 0.9 : 0;
    const fuelWaterDefault = fuelWaterMax > 0 ? fuelWaterMax * 0.9 : 0;

    return {
      loxMax,
      fuelMax,
      loxWaterMax,
      fuelWaterMax,
      loxDefault,
      fuelDefault,
      loxWaterDefault,
      fuelWaterDefault,
      loxRadiusM,
      loxHeightM,
      fuelRadiusM,
      fuelHeightM,
      loxVolumeM3: loxVol,
      fuelVolumeM3: fuelVol,
    };
  }, [config]);

  /** When both tanks have r+h, scale row so the physically tallest hits max px height; the other shrinks in both dimensions */
  const blowdownTankRowPixels = useMemo(() => {
    const fr = tankCapacities.fuelRadiusM;
    const fh = tankCapacities.fuelHeightM;
    const lr = tankCapacities.loxRadiusM;
    const lh = tankCapacities.loxHeightM;
    const fuelOk = fr != null && fh != null && fr > 0 && fh > 0;
    const loxOk = lr != null && lh != null && lr > 0 && lh > 0;
    if (!fuelOk || !loxOk) return null;

    const MAX_H = 200;
    const MAX_W = 140;
    const hMax = Math.max(fh, lh);

    const intrinsic = (hM: number, rM: number) => {
      const dM = 2 * rM;
      const dOverH = dM / hM;
      const pxH = MAX_H * (hM / hMax);
      const pxW = pxH * dOverH;
      return { pxW, pxH };
    };

    let fuelP = intrinsic(fh, fr);
    let loxP = intrinsic(lh, lr);
    const maxW = Math.max(fuelP.pxW, loxP.pxW);
    if (maxW > MAX_W) {
      const s = MAX_W / maxW;
      fuelP = { pxW: fuelP.pxW * s, pxH: fuelP.pxH * s };
      loxP = { pxW: loxP.pxW * s, pxH: loxP.pxH * s };
    }
    return { fuel: fuelP, lox: loxP };
  }, [
    tankCapacities.fuelRadiusM,
    tankCapacities.fuelHeightM,
    tankCapacities.loxRadiusM,
    tankCapacities.loxHeightM,
  ]);

  // ---- Editable fill levels (seeded once from config, then user-controlled) ----
  const [loxInitialMass, setLoxInitialMass] = useState(0);
  const [fuelInitialMass, setFuelInitialMass] = useState(0);
  const [loxWaterMass, setLoxWaterMass] = useState(0);
  const [fuelWaterMass, setFuelWaterMass] = useState(0);

  // Seed editable masses when config (and derived capacities) change
  useEffect(() => {
    if (!config) return;
    setLoxInitialMass(tankCapacities.loxDefault);
    setFuelInitialMass(tankCapacities.fuelDefault);
    setLoxWaterMass(tankCapacities.loxWaterDefault);
    setFuelWaterMass(tankCapacities.fuelWaterDefault);
  }, [config, tankCapacities]);

  // When a YAML config loads or changes, seed Pure Blowdown pressures and duration.
  useEffect(() => {
    if (!config) return;
    const { loxPsi, fuelPsi, durationS } = readTimeseriesDefaultsFromConfig(config);
    if (loxPsi !== undefined) setLoxInitialPressure(loxPsi);
    if (fuelPsi !== undefined) setFuelInitialPressure(fuelPsi);
    if (durationS !== undefined && durationS >= 0.1 && durationS <= 600) {
      setSegmentDuration(durationS);
      setDuration(durationS);
    }
  }, [config]);

  /** Hot fire ↔ water flow: keep liquid volume (L) the same when tank volume is known; else keep fill %. */
  const switchBlowdownTestType = (next: 'hotfire' | 'waterflow') => {
    if (next === testType) return;
    const tc = tankCapacities;

    if (testType === 'hotfire' && next === 'waterflow') {
      const loxL = liquidLitersFromMassAndCapacity(loxInitialMass, tc.loxMax, tc.loxVolumeM3);
      const fuelL = liquidLitersFromMassAndCapacity(fuelInitialMass, tc.fuelMax, tc.fuelVolumeM3);

      if (loxL !== null) {
        setLoxWaterMass(massFromLiquidLiters(loxL, tc.loxWaterMax, tc.loxVolumeM3));
      } else if (tc.loxMax > 0 && tc.loxWaterMax > 0) {
        setLoxWaterMass(clamp01(loxInitialMass / tc.loxMax) * tc.loxWaterMax);
      }

      if (fuelL !== null) {
        setFuelWaterMass(massFromLiquidLiters(fuelL, tc.fuelWaterMax, tc.fuelVolumeM3));
      } else if (tc.fuelMax > 0 && tc.fuelWaterMax > 0) {
        setFuelWaterMass(clamp01(fuelInitialMass / tc.fuelMax) * tc.fuelWaterMax);
      }
    } else if (testType === 'waterflow' && next === 'hotfire') {
      const loxL = liquidLitersFromMassAndCapacity(loxWaterMass, tc.loxWaterMax, tc.loxVolumeM3);
      const fuelL = liquidLitersFromMassAndCapacity(fuelWaterMass, tc.fuelWaterMax, tc.fuelVolumeM3);

      if (loxL !== null) {
        setLoxInitialMass(massFromLiquidLiters(loxL, tc.loxMax, tc.loxVolumeM3));
      } else if (tc.loxWaterMax > 0 && tc.loxMax > 0) {
        setLoxInitialMass(clamp01(loxWaterMass / tc.loxWaterMax) * tc.loxMax);
      }

      if (fuelL !== null) {
        setFuelInitialMass(massFromLiquidLiters(fuelL, tc.fuelMax, tc.fuelVolumeM3));
      } else if (tc.fuelWaterMax > 0 && tc.fuelMax > 0) {
        setFuelInitialMass(clamp01(fuelWaterMass / tc.fuelWaterMax) * tc.fuelMax);
      }
    }

    setTestType(next);
  };

  // Upload state
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Sync local input states
  useEffect(() => {
    setSegmentDurationInput(segmentDuration.toString());
  }, [segmentDuration]);

  useEffect(() => {
    setNPointsInput(nPoints.toString());
  }, [nPoints]);

  const commitSegmentDuration = (value: string) => {
    const num = parseFloat(value);
    if (isNaN(num) || num < 0.1 || num > 600) {
      setSegmentDurationInput(segmentDuration.toString());
      return;
    }
    setSegmentDuration(num);
    setSegmentDurationInput(num.toString());
  };

  const commitNPoints = (value: string) => {
    const num = parseInt(value);
    if (isNaN(num) || num < 10 || num > 2000) {
      setNPointsInput(nPoints.toString());
      return;
    }
    setNPoints(num);
    setNPointsInput(num.toString());
  };

  // Results state - initialize from sessionStorage
  const [results, setResults] = useState<{
    data: TimeSeriesData;
    summary: TimeSeriesSummary;
  } | null>(() => loadResultsFromSession());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useColdFlowCd, setUseColdFlowCd] = useState(true);

  // Handle simple profile submission
  const handleSimpleSubmit = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setResults(null);

    const response = await generateTimeseries({
      duration_s: duration,
      n_steps: nSteps,
      lox_profile: loxProfile,
      fuel_profile: fuelProfile,
      use_cold_flow_cd: hasCdFit(config) ? useColdFlowCd : undefined,
    });

    setIsLoading(false);

    if (response.error) {
      setError(typeof response.error === 'string' ? response.error : JSON.stringify(response.error));
    } else if (response.data) {
      const newResults = {
        data: response.data.data,
        summary: response.data.summary,
      };
      setResults(newResults);
      saveResultsToSession(newResults);
    }
  }, [duration, nSteps, loxProfile, fuelProfile, useColdFlowCd, config]);

  // Handle segment-based submission
  const handleSegmentSubmit = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setResults(null);

    const response = await generateFromSegments({
      duration_s: segmentDuration,
      n_points: nPoints,
      lox_segments: loxSegments,
      fuel_segments: fuelSegments,
      blowdown_mode: false,
      use_cold_flow_cd: hasCdFit(config) ? useColdFlowCd : undefined,
    });

    setIsLoading(false);

    if (response.error) {
      setError(typeof response.error === 'string' ? response.error : JSON.stringify(response.error));
    } else if (response.data) {
      const newResults = {
        data: response.data.data,
        summary: response.data.summary,
      };
      setResults(newResults);
      saveResultsToSession(newResults);
    }
  }, [segmentDuration, nPoints, loxSegments, fuelSegments, useColdFlowCd, config]);

  // Handle blowdown submission (hot-fire or water flow)
  const handleBlowdownSubmit = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setResults(null);

    const isWaterflow = testType === 'waterflow';
    const activeLoxMass = isWaterflow ? loxWaterMass : loxInitialMass;
    const activeFuelMass = isWaterflow ? fuelWaterMass : fuelInitialMass;

    const response = await generateFromSegments({
      duration_s: segmentDuration,
      n_points: nPoints,
      lox_segments: [],
      fuel_segments: [],
      blowdown_mode: true,
      lox_initial_pressure_psi: loxInitialPressure,
      fuel_initial_pressure_psi: fuelInitialPressure,
      waterflow_mode: isWaterflow,
      lox_initial_mass_kg: activeLoxMass > 0 ? activeLoxMass : undefined,
      fuel_initial_mass_kg: activeFuelMass > 0 ? activeFuelMass : undefined,
      ...(showSolenoidSchedule && loxPwmSegments.length > 0
        ? { lox_solenoid_schedule: pwmToIntervals(loxPwmSegments) }
        : {}),
      ...(showSolenoidSchedule && fuelPwmSegments.length > 0
        ? { fuel_solenoid_schedule: pwmToIntervals(fuelPwmSegments) }
        : {}),
      use_cold_flow_cd: hasCdFit(config) ? useColdFlowCd : undefined,
    });

    setIsLoading(false);

    if (response.error) {
      setError(typeof response.error === 'string' ? response.error : JSON.stringify(response.error));
    } else if (response.data) {
      const newResults = {
        data: response.data.data,
        summary: response.data.summary,
      };
      setResults(newResults);
      saveResultsToSession(newResults);
    }
  }, [
    segmentDuration,
    nPoints,
    loxInitialPressure,
    fuelInitialPressure,
    testType,
    loxInitialMass,
    fuelInitialMass,
    loxWaterMass,
    fuelWaterMass,
    showSolenoidSchedule,
    loxPwmSegments,
    fuelPwmSegments,
    useColdFlowCd,
    config,
  ]);


  // Handle CSV upload submission
  const handleUploadSubmit = useCallback(async () => {
    if (!uploadedFile) {
      setUploadError('Please select a file');
      return;
    }

    setIsLoading(true);
    setError(null);
    setUploadError(null);
    setResults(null);

    const response = await uploadTimeseriesFromCSV(uploadedFile);

    setIsLoading(false);

    if (response.error) {
      const errorMsg = typeof response.error === 'string' ? response.error : JSON.stringify(response.error);
      setError(errorMsg);
      setUploadError(errorMsg);
    } else if (response.data) {
      const newResults = {
        data: response.data.data,
        summary: response.data.summary,
      };
      setResults(newResults);
      saveResultsToSession(newResults);

      // If it was a YAML config file, fetch and update the config
      const isConfigFile = uploadedFile.name.endsWith('.yaml') || uploadedFile.name.endsWith('.yml');
      if (isConfigFile && onConfigLoaded) {
        const configResponse = await getConfig();
        if (configResponse.data) {
          onConfigLoaded(configResponse.data.config);
        }
      }
    }
  }, [uploadedFile, onConfigLoaded]);

  if (!config) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--color-text-secondary)]">
        <div className="text-center">
          <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <p>No config loaded</p>
          <p className="text-sm mt-1">Upload a YAML config file first</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-purple-500 to-pink-600 flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Time-Series Analysis</h2>
            <p className="text-sm text-[var(--color-text-secondary)]">
              Generate pressure profiles and evaluate thrust performance over time
            </p>
          </div>
        </div>

        {/* Mode Toggle */}
        <div className="flex gap-2 p-1 bg-[var(--color-bg-primary)] rounded-lg w-fit">
          <button
            onClick={() => setInputMode('simple')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${inputMode === 'simple'
              ? 'bg-blue-600 text-white'
              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }`}
          >
            Simple Profile
          </button>
          <button
            onClick={() => setInputMode('segments')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${inputMode === 'segments'
              ? 'bg-blue-600 text-white'
              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }`}
          >
            Segment Builder
          </button>
          <button
            onClick={() => setInputMode('blowdown')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${inputMode === 'blowdown'
              ? 'bg-blue-600 text-white'
              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }`}
          >
            Pure Blowdown
          </button>
          <button
            onClick={() => setInputMode('upload')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${inputMode === 'upload'
              ? 'bg-blue-600 text-white'
              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }`}
          >
            Upload
          </button>
        </div>

        {/* Cold-flow Cd toggle — only shown when fit is saved in config */}
        {hasCdFit(config) && (
          <div className="flex items-center gap-3 mt-3">
            <button
              role="switch"
              aria-checked={useColdFlowCd}
              onClick={() => setUseColdFlowCd(v => !v)}
              className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${useColdFlowCd ? 'bg-amber-500' : 'bg-gray-600'}`}
            >
              <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${useColdFlowCd ? 'translate-x-4' : 'translate-x-0'}`} />
            </button>
            <span className="text-sm text-[var(--color-text-secondary)]">
              Use CdA Cold Flow&nbsp;
              <span className="font-mono text-xs opacity-70">(CdA = a·√ΔP + b)</span>
            </span>
          </div>
        )}
      </div>

      {/* Input Section */}
      <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        {inputMode === 'simple' ? (
          <>
            <h3 className="text-sm font-semibold mb-4 text-[var(--color-text-primary)]">
              Generate Profile
            </h3>
            <PressureProfileForm
              duration={duration}
              nSteps={nSteps}
              loxProfile={loxProfile}
              fuelProfile={fuelProfile}
              onDurationChange={setDuration}
              onNStepsChange={setNSteps}
              onLoxProfileChange={setLoxProfile}
              onFuelProfileChange={setFuelProfile}
              onSubmit={handleSimpleSubmit}
              isLoading={isLoading}
            />
          </>
        ) : inputMode === 'segments' ? (
          <>
            <h3 className="text-sm font-semibold mb-4 text-[var(--color-text-primary)]">
              Interactive Segment Builder
            </h3>
            <p className="text-sm text-[var(--color-text-secondary)] mb-6">
              Build custom pressure curves by defining segments. Each segment uses a blowdown
              profile: P(t) = P_end + (P_start - P_end) × e^(-k×t). Drag endpoints to adjust
              pressures, drag boundaries to adjust timing.
            </p>

            {/* Duration and Points */}
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm text-[var(--color-text-secondary)] mb-2">
                  Duration
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={segmentDurationInput}
                    onChange={(e) => setSegmentDurationInput(e.target.value)}
                    onBlur={(e) => commitSegmentDuration(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.currentTarget.blur();
                      }
                    }}
                    className="w-full px-4 py-3 pr-8 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] focus:outline-none focus:border-blue-500"
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-[var(--color-text-secondary)]">s</span>
                </div>
              </div>
              <div>
                <label className="block text-sm text-[var(--color-text-secondary)] mb-2">
                  Points
                </label>
                <input
                  type="text"
                  value={nPointsInput}
                  onChange={(e) => setNPointsInput(e.target.value)}
                  onBlur={(e) => commitNPoints(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    }
                  }}
                  className="w-full px-4 py-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            {/* LOX and Fuel Segment Builders - Side by Side */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
              {/* LOX Segment Builder */}
              <div>
                <SegmentCurveBuilder
                  label="LOX Pressure Profile"
                  segments={loxSegments}
                  onChange={setLoxSegments}
                  colorClass="border-cyan-500/30 bg-cyan-500/5"
                  strokeColor="#06b6d4"
                  minPressure={300}
                  maxPressure={1100}
                  duration={segmentDuration}
                  overlaySegments={fuelSegments}
                  overlayStrokeColor="#f97316"
                />
              </div>

              {/* Fuel Segment Builder */}
              <div>
                <SegmentCurveBuilder
                  label="Fuel Pressure Profile"
                  segments={fuelSegments}
                  onChange={setFuelSegments}
                  colorClass="border-orange-500/30 bg-orange-500/5"
                  strokeColor="#f97316"
                  minPressure={300}
                  maxPressure={1100}
                  duration={segmentDuration}
                  overlaySegments={loxSegments}
                  overlayStrokeColor="#06b6d4"
                />
              </div>
            </div>

            {/* Run Button */}
            <button
              onClick={handleSegmentSubmit}
              disabled={isLoading}
              className="w-full px-6 py-3 rounded-lg bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Running Time-Series...
                </>
              ) : (
                <>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                  Run Time-Series from Segments
                </>
              )}
            </button>
          </>
        ) : inputMode === 'blowdown' ? (
          <>
            <h3 className="text-sm font-semibold mb-3 text-[var(--color-text-primary)]">
              Pure Blowdown Simulation
            </h3>

            {/* Test Type Toggle */}
            <div className="flex gap-1 p-1 bg-[var(--color-bg-primary)] rounded-lg mb-4 w-fit">
              <button
                type="button"
                onClick={() => switchBlowdownTestType('hotfire')}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  testType === 'hotfire'
                    ? 'bg-orange-500/20 text-orange-300 border border-orange-500/40'
                    : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                Hot Fire
              </button>
              <button
                type="button"
                onClick={() => switchBlowdownTestType('waterflow')}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  testType === 'waterflow'
                    ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                    : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                Water Flow
              </button>
            </div>

            {testType === 'hotfire' ? (
              <p className="text-sm text-[var(--color-text-secondary)] mb-6">
                Simulate tank blowdown without COPV regulation or active pressure control.
                Tanks start at the specified initial pressure and naturally decay as propellant is consumed
                according to physics-based polytropic expansion with real gas effects.
              </p>
            ) : (
              <div className="mb-6 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
                <p className="text-sm text-blue-300">
                  <span className="font-semibold">Water Flow Test mode</span> — simulates a cold-flow bench test with water.
                  Tanks contain water pressurized by N2. Water flows through the injector at atmospheric
                  back-pressure with no combustion. Use this to validate the blowdown solver against
                  measured test data. Combustion metrics (Pc, Thrust, Isp) are not applicable.
                </p>
              </div>
            )}

            <div className="max-w-xl">
              {/* Tank fill visualizers */}
              <div className="mb-6">
                <h4 className="text-xs font-medium text-[var(--color-text-secondary)] mb-3 uppercase tracking-wider">
                  Initial Tank Fill
                </h4>
                <div className="flex gap-8 justify-start items-end flex-wrap">
                  {testType === 'hotfire' ? (
                    <>
                      <TankFillVisualizer
                        label="Fuel Tank"
                        mass={fuelInitialMass}
                        maxMass={tankCapacities.fuelMax}
                        tankVolumeM3={tankCapacities.fuelVolumeM3}
                        fluidColor="#f97316"
                        onChange={setFuelInitialMass}
                        radiusM={tankCapacities.fuelRadiusM}
                        heightM={tankCapacities.fuelHeightM}
                        pixelSize={
                          blowdownTankRowPixels
                            ? { width: blowdownTankRowPixels.fuel.pxW, height: blowdownTankRowPixels.fuel.pxH }
                            : null
                        }
                      />
                      <TankFillVisualizer
                        label="LOX Tank"
                        mass={loxInitialMass}
                        maxMass={tankCapacities.loxMax}
                        tankVolumeM3={tankCapacities.loxVolumeM3}
                        fluidColor="#22d3ee"
                        onChange={setLoxInitialMass}
                        radiusM={tankCapacities.loxRadiusM}
                        heightM={tankCapacities.loxHeightM}
                        pixelSize={
                          blowdownTankRowPixels
                            ? { width: blowdownTankRowPixels.lox.pxW, height: blowdownTankRowPixels.lox.pxH }
                            : null
                        }
                      />
                    </>
                  ) : (
                    <>
                      <TankFillVisualizer
                        label="Fuel Tank"
                        mass={fuelWaterMass}
                        maxMass={tankCapacities.fuelWaterMax}
                        tankVolumeM3={tankCapacities.fuelVolumeM3}
                        fluidColor="#3b82f6"
                        onChange={setFuelWaterMass}
                        radiusM={tankCapacities.fuelRadiusM}
                        heightM={tankCapacities.fuelHeightM}
                        pixelSize={
                          blowdownTankRowPixels
                            ? { width: blowdownTankRowPixels.fuel.pxW, height: blowdownTankRowPixels.fuel.pxH }
                            : null
                        }
                      />
                      <TankFillVisualizer
                        label="LOX Tank"
                        mass={loxWaterMass}
                        maxMass={tankCapacities.loxWaterMax}
                        tankVolumeM3={tankCapacities.loxVolumeM3}
                        fluidColor="#3b82f6"
                        onChange={setLoxWaterMass}
                        radiusM={tankCapacities.loxRadiusM}
                        heightM={tankCapacities.loxHeightM}
                        pixelSize={
                          blowdownTankRowPixels
                            ? { width: blowdownTankRowPixels.lox.pxW, height: blowdownTankRowPixels.lox.pxH }
                            : null
                        }
                      />
                    </>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 mt-3">
                  <button
                    type="button"
                    onClick={() => {
                      if (testType === 'hotfire') {
                        setLoxInitialMass(tankCapacities.loxDefault);
                        setFuelInitialMass(tankCapacities.fuelDefault);
                      } else {
                        setLoxWaterMass(tankCapacities.loxWaterDefault);
                        setFuelWaterMass(tankCapacities.fuelWaterDefault);
                      }
                    }}
                    className="px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)] transition-colors"
                  >
                    Reset masses to config
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const { loxPsi, fuelPsi } = readTimeseriesDefaultsFromConfig(config);
                      if (loxPsi !== undefined) setLoxInitialPressure(loxPsi);
                      if (fuelPsi !== undefined) setFuelInitialPressure(fuelPsi);
                    }}
                    className="px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)] transition-colors"
                  >
                    Reset pressures to config
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-6">
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-2">
                    {testType === 'waterflow' ? 'LOX-Side Tank Initial Pressure (psi)' : 'LOX Initial Pressure (psi)'}
                  </label>
                  <input
                    type="number"
                    value={loxInitialPressure}
                    onChange={(e) => setLoxInitialPressure(parseFloat(e.target.value) || 0)}
                    min={100}
                    max={2000}
                    step={10}
                    className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-2">
                    {testType === 'waterflow' ? 'Fuel-Side Tank Initial Pressure (psi)' : 'Fuel Initial Pressure (psi)'}
                  </label>
                  <input
                    type="number"
                    value={fuelInitialPressure}
                    onChange={(e) => setFuelInitialPressure(parseFloat(e.target.value) || 0)}
                    min={100}
                    max={2000}
                    step={10}
                    className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              {/* Solenoid PWM Schedule (optional) */}
              <div style={{ marginTop: 12, borderTop: '1px solid var(--color-border)', paddingTop: 10 }}>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 12,
                    cursor: 'pointer',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={showSolenoidSchedule}
                    onChange={e => setShowSolenoidSchedule(e.target.checked)}
                    disabled={testType === 'waterflow'}
                  />
                  Pressurant Solenoid Schedule (optional — requires press_system config)
                  {testType === 'waterflow' && (
                    <span style={{ fontSize: 11, opacity: 0.8 }}>(disabled in water flow mode)</span>
                  )}
                </label>
                {showSolenoidSchedule && testType !== 'waterflow' && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 8 }}>
                    <PwmEditor
                      label="LOX Pressurant Solenoid"
                      segments={loxPwmSegments}
                      onChange={setLoxPwmSegments}
                      accentColor="#60a5fa"
                    />
                    <PwmEditor
                      label="Fuel Pressurant Solenoid"
                      segments={fuelPwmSegments}
                      onChange={setFuelPwmSegments}
                      accentColor="#f97316"
                    />
                  </div>
                )}
              </div>


              {/* Duration and Points */}
              <h4 className="text-xs font-medium text-[var(--color-text-secondary)] mb-2 uppercase tracking-wider">Simulation Settings</h4>
              <div className="grid grid-cols-2 gap-4 mb-6">
                <div>
                  <label className="block text-sm text-[var(--color-text-secondary)] mb-2">
                    Duration
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={segmentDurationInput}
                      onChange={(e) => setSegmentDurationInput(e.target.value)}
                      onBlur={(e) => commitSegmentDuration(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.currentTarget.blur();
                        }
                      }}
                      className="w-full px-4 py-3 pr-8 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] focus:outline-none focus:border-blue-500"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-[var(--color-text-secondary)]">s</span>
                  </div>
                </div>
                <div>
                  <label className="block text-sm text-[var(--color-text-secondary)] mb-2">
                    Points
                  </label>
                  <input
                    type="text"
                    value={nPointsInput}
                    onChange={(e) => setNPointsInput(e.target.value)}
                    onBlur={(e) => commitNPoints(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.currentTarget.blur();
                      }
                    }}
                    className="w-full px-4 py-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              {/* Run Button */}
              <button
                onClick={handleBlowdownSubmit}
                disabled={isLoading}
                className={`w-full px-6 py-3 rounded-lg text-white font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 ${
                  testType === 'waterflow'
                    ? 'bg-gradient-to-r from-blue-500 to-cyan-600 hover:from-blue-600 hover:to-cyan-700'
                    : 'bg-gradient-to-r from-teal-500 to-emerald-600 hover:from-teal-600 hover:to-emerald-700'
                }`}
              >
                {isLoading ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Simulating...
                  </>
                ) : testType === 'waterflow' ? (
                  <>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
                    </svg>
                    Run Water Flow Simulation
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    Run Blowdown Simulation
                  </>
                )}
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="text-sm font-semibold mb-4 text-[var(--color-text-primary)]">
              Upload CSV or Config File
            </h3>
            <p className="text-xs text-[var(--color-text-secondary)] mb-4">
              Upload a <strong>CSV file</strong> with columns <strong>T</strong> (time in seconds), <strong>P_O</strong> (LOX tank pressure in psi),
              and <strong>P_F</strong> (Fuel tank pressure in psi). The time column is optional - if missing,
              uniform spacing will be assumed.
            </p>
            <p className="text-xs text-[var(--color-text-secondary)] mb-4">
              Alternatively, upload a <strong>YAML config file</strong> with a <code className="text-xs bg-[var(--color-bg-primary)] px-1 py-0.5 rounded">pressure_curves</code> section.
              The config will be set as the active session config, and time-series analysis will run using the pressure curves from the segments.
            </p>

            {/* File Upload */}
            <div className="mb-4">
              <label className="block text-sm text-[var(--color-text-secondary)] mb-2">
                Select CSV or YAML File
              </label>
              <div className="relative">
                <input
                  type="file"
                  accept=".csv,.yaml,.yml"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      setUploadedFile(file);
                      setUploadError(null);
                    }
                  }}
                  className="w-full px-4 py-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] focus:outline-none focus:border-blue-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                />
              </div>
              {uploadedFile && (
                <div className="mt-2 text-sm text-[var(--color-text-secondary)]">
                  Selected: <span className="text-[var(--color-text-primary)] font-medium">{uploadedFile.name}</span>
                  <span className="ml-2 text-xs">({(uploadedFile.size / 1024).toFixed(1)} KB)</span>
                  {uploadedFile.name.endsWith('.yaml') || uploadedFile.name.endsWith('.yml') ? (
                    <span className="ml-2 text-xs text-blue-400">(Config file)</span>
                  ) : (
                    <span className="ml-2 text-xs text-blue-400">(CSV file)</span>
                  )}
                </div>
              )}
              {uploadError && (
                <div className="mt-2 text-sm text-red-400">
                  {uploadError}
                </div>
              )}
            </div>

            {/* Run Button */}
            <button
              onClick={handleUploadSubmit}
              disabled={isLoading || !uploadedFile}
              className="w-full px-6 py-3 rounded-lg bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Running Time-Series...
                </>
              ) : (
                <>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  {uploadedFile && (uploadedFile.name.endsWith('.yaml') || uploadedFile.name.endsWith('.yml'))
                    ? 'Run Time-Series from Config'
                    : 'Run Time-Series from CSV'}
                </>
              )}
            </button>
          </>
        )}

        {/* Error Message */}
        {error && (
          <div className="mt-4 p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400">
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <p className="font-medium">Evaluation Failed</p>
                <p className="text-sm mt-1">{error}</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Results Section */}
      {results && (
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-green-500/20 flex items-center justify-center">
              <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-semibold text-[var(--color-text-primary)]">
                  Time-Series Results
                </h3>
                {results.summary?.is_waterflow && (
                  <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30">
                    Water Flow Test
                  </span>
                )}
              </div>
              <p className="text-sm text-[var(--color-text-secondary)]">
                {results.data.time.length} data points over{' '}
                {results.summary?.is_waterflow
                  ? `${(results.summary?.flow_duration_s ?? results.summary?.burn_time_s)?.toFixed(2) || '—'}s flow`
                  : `${results.summary?.burn_time_s?.toFixed(2) || '—'}s burn`}
              </p>
            </div>
          </div>

          {/* Water flow test summary stats */}
          {results.summary?.is_waterflow && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <p className="text-xs text-[var(--color-text-secondary)] mb-1">Avg LOX-side mdot</p>
                <p className="text-lg font-semibold text-[var(--color-text-primary)]">
                  {results.summary.avg_mdot_lox_kg_s != null ? results.summary.avg_mdot_lox_kg_s.toFixed(3) : '—'}
                  <span className="text-xs font-normal text-[var(--color-text-secondary)] ml-1">kg/s</span>
                </p>
              </div>
              <div className="p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <p className="text-xs text-[var(--color-text-secondary)] mb-1">Avg Fuel-side mdot</p>
                <p className="text-lg font-semibold text-[var(--color-text-primary)]">
                  {results.summary.avg_mdot_fuel_kg_s != null ? results.summary.avg_mdot_fuel_kg_s.toFixed(3) : '—'}
                  <span className="text-xs font-normal text-[var(--color-text-secondary)] ml-1">kg/s</span>
                </p>
              </div>
              <div className="p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <p className="text-xs text-[var(--color-text-secondary)] mb-1">Total Water Used</p>
                <p className="text-lg font-semibold text-[var(--color-text-primary)]">
                  {results.summary.total_water_consumed_kg != null ? results.summary.total_water_consumed_kg.toFixed(2) : '—'}
                  <span className="text-xs font-normal text-[var(--color-text-secondary)] ml-1">kg</span>
                </p>
              </div>
              <div className="p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <p className="text-xs text-[var(--color-text-secondary)] mb-1">Flow Duration</p>
                <p className="text-lg font-semibold text-[var(--color-text-primary)]">
                  {results.summary.flow_duration_s != null ? results.summary.flow_duration_s.toFixed(2) : '—'}
                  <span className="text-xs font-normal text-[var(--color-text-secondary)] ml-1">s</span>
                </p>
              </div>
            </div>
          )}

          {/* Shutdown/depletion event banner */}
          {results.summary?.shutdown_event && (
            <div className={`p-4 border rounded-lg ${
              results.summary.is_waterflow
                ? 'bg-blue-500/10 border-blue-500/30'
                : 'bg-amber-500/10 border-amber-500/30'
            }`}>
              <div className="flex items-start gap-3">
                <svg className={`w-5 h-5 mt-0.5 flex-shrink-0 ${results.summary.is_waterflow ? 'text-blue-400' : 'text-amber-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>
                  <p className={`font-medium ${results.summary.is_waterflow ? 'text-blue-400' : 'text-amber-400'}`}>
                    {results.summary.is_waterflow ? 'Water Depleted' : 'Engine Shutdown Detected'}
                  </p>
                  <p className={`text-sm mt-0.5 ${results.summary.is_waterflow ? 'text-blue-300/80' : 'text-amber-300/80'}`}>
                    {results.summary.is_waterflow ? 'Flow stopped' : 'Shutdown'} at{' '}
                    <span className="font-mono font-semibold">
                      {results.summary.shutdown_event.time_s.toFixed(3)}s
                    </span>
                    {!results.summary.is_waterflow && (
                      <>
                        {' — '}
                        {results.summary.shutdown_event.reason === 'supply_below_demand'
                          ? 'Tank pressure insufficient to sustain combustion (supply below demand)'
                          : results.summary.shutdown_event.reason === 'pressure_bounds_invalid'
                          ? 'Tank pressure critically low — chamber pressure bounds collapsed'
                          : results.summary.shutdown_event.reason === 'propellant_depleted'
                          ? 'Propellant exhausted'
                          : results.summary.shutdown_event.reason}
                      </>
                    )}
                  </p>
                  <p className={`text-xs mt-0.5 ${results.summary.is_waterflow ? 'text-blue-300/60' : 'text-amber-300/60'}`}>
                    {results.summary.is_waterflow
                      ? `Both tanks emptied. Results valid up to ${results.summary.shutdown_event.time_s.toFixed(3)}s.`
                      : `Performance data zeroed after shutdown. Results valid up to ${results.summary.shutdown_event.time_s.toFixed(3)}s.`}
                  </p>
                </div>
              </div>
            </div>
          )}

          <PressureCurveChart
            data={results.data}
            summary={results.summary}
          />
        </div>
      )}

      {/* Empty state when no results */}
      {!results && !isLoading && !error && (
        <div className="p-8 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-center">
          <svg className="w-16 h-16 mx-auto mb-4 text-[var(--color-text-secondary)] opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
          <p className="text-[var(--color-text-secondary)]">
            Configure pressure profiles above and run to see time-series results
          </p>
        </div>
      )}
    </div>
  );
}

