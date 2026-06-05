import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import {
  runTankFreezeStream,
  type TankFreezeRequest,
  type TankFreezeBoundResult,
  type TankFreezeFluid,
} from '../api/client';

// ---------------------------------------------------------------------------
// Fluid metadata (mirrors tank_freeze/properties.py FLUIDS). sinkRank encodes
// the fixed saturation-temperature ordering lox < methane < ethanol: in any
// mixed combo the lower-rank fluid is the boiling fixed-T sink, the other is
// the freezable bulk.
// ---------------------------------------------------------------------------
const FLUID_INFO: Record<TankFreezeFluid, {
  label: string;
  sinkRank: number;
  defaultT0: string;            // sensible initial bulk temperature [K]
  rho: (T: number) => number;   // liquid density linearization [kg/m^3]
  materials: { kS: string; rhoS: string; cpS: string; lFus: string; tFr: string };
}> = {
  ethanol: {
    label: 'Ethanol', sinkRank: 2, defaultT0: '293',
    rho: (T) => 783.5 + 0.857 * (300 - T), // ~1% over 200-320 K
    materials: { kS: '0.5', rhoS: '1025', cpS: '1200', lFus: '105000', tFr: '159' },
  },
  methane: {
    label: 'Methane', sinkRank: 1, defaultT0: '105',
    rho: (T) => 451.5 - 1.4 * (T - 90.7), // ~1% over 90-115 K
    materials: { kS: '0.3', rhoS: '522', cpS: '2100', lFus: '58700', tFr: '90.69' },
  },
  lox: {
    label: 'LOX', sinkRank: 0, defaultT0: '90.2',
    rho: (T) => 1141 - 4.5 * (T - 90.2),
    materials: { kS: '0.2', rhoS: '1334', cpS: '900', lFus: '13900', tFr: '54.36' },
  },
};

// ---------------------------------------------------------------------------
// Local UI helpers (per-component convention, see FlightSimulation.tsx)
// ---------------------------------------------------------------------------

function CollapsibleSection({
  title,
  icon,
  children,
  defaultExpanded = false,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  defaultExpanded?: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  return (
    <div className="border border-[var(--color-border)] rounded-lg overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-hover)] transition-colors"
      >
        <div className="flex items-center gap-2">
          {icon}
          <span className="font-medium text-[var(--color-text-primary)]">{title}</span>
        </div>
        <svg
          className={`w-5 h-5 text-[var(--color-text-secondary)] transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {isExpanded && <div className="p-4 bg-[var(--color-bg-secondary)]">{children}</div>}
    </div>
  );
}

function InputField({
  label,
  value,
  onChange,
  unit,
  help,
  min,
  max,
  step,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  unit?: string;
  help?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="block text-sm text-[var(--color-text-secondary)] mb-1">{label}</label>
      <div className="relative">
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          className="w-full px-3 py-2 pr-12 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] placeholder-gray-500 focus:outline-none focus:border-sky-500 transition-colors disabled:opacity-50"
        />
        {unit && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] text-sm">
            {unit}
          </span>
        )}
      </div>
      {help && <p className="text-xs text-[var(--color-text-muted)] mt-1">{help}</p>}
    </div>
  );
}

function MetricCard({
  label,
  value,
  unit,
  subValue,
  color = 'blue',
}: {
  label: string;
  value: string;
  unit: string;
  subValue?: string;
  color?: 'blue' | 'green' | 'purple' | 'orange' | 'red' | 'gray';
}) {
  const colorClasses = {
    blue: 'from-blue-500/20 to-blue-600/10 border-blue-500/30',
    green: 'from-green-500/20 to-green-600/10 border-green-500/30',
    purple: 'from-purple-500/20 to-purple-600/10 border-purple-500/30',
    orange: 'from-orange-500/20 to-orange-600/10 border-orange-500/30',
    red: 'from-red-500/20 to-red-600/10 border-red-500/30',
    gray: 'from-slate-500/20 to-slate-600/10 border-slate-500/30',
  };

  return (
    <div className={`p-4 rounded-xl bg-gradient-to-br ${colorClasses[color]} border`}>
      <p className="text-sm text-[var(--color-text-secondary)]">{label}</p>
      <p className="text-2xl font-bold text-[var(--color-text-primary)] mt-1">
        {value} <span className="text-base font-normal text-[var(--color-text-secondary)]">{unit}</span>
      </p>
      {subValue && <p className="text-sm text-[var(--color-text-muted)] mt-1">{subValue}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart helpers — each bound has its own time base, so every Line carries its
// own data array (XAxis type="number" makes recharts align them).
// ---------------------------------------------------------------------------

interface SeriesDef {
  name: string;
  color: string;
  dashed?: boolean;
  data: { t: number; v: number }[];
}

interface RefLineDef {
  y: number;
  label: string;
  color: string;
}

function ChartCard({
  title,
  yLabel,
  series,
  refLines = [],
  logScale = false,
  valueFormatter,
}: {
  title: string;
  yLabel: string;
  series: SeriesDef[];
  refLines?: RefLineDef[];
  logScale?: boolean;
  valueFormatter?: (v: number) => string;
}) {
  const fmt = valueFormatter ?? ((v: number) => v.toPrecision(4));
  return (
    <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
      <h4 className="text-sm font-medium text-[var(--color-text-primary)] mb-3">{title}</h4>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart margin={{ top: 5, right: 20, bottom: 18, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis
            dataKey="t"
            type="number"
            domain={[0, 'dataMax']}
            stroke="var(--color-text-secondary)"
            fontSize={11}
            tickFormatter={(v: number) => `${+v.toFixed(1)}`}
            label={{ value: 'Time (min)', position: 'insideBottom', offset: -10, fontSize: 11 }}
          />
          <YAxis
            stroke="var(--color-text-secondary)"
            fontSize={11}
            scale={logScale ? 'log' : 'auto'}
            domain={logScale ? ['auto', 'auto'] : undefined}
            tickFormatter={(v: number) => (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-2 && v !== 0) ? v.toExponential(1) : `${+v.toFixed(3)}`)}
            label={{ value: yLabel, angle: -90, position: 'insideLeft', fontSize: 11 }}
            width={70}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--color-bg-tertiary)',
              border: '1px solid var(--color-border)',
              borderRadius: '8px',
              fontSize: 12,
            }}
            labelFormatter={(t) => `t = ${Number(t).toFixed(2)} min`}
            formatter={(value) => fmt(Number(value))}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} verticalAlign="top" />
          {series.map((s) => (
            <Line
              key={s.name}
              name={s.name}
              data={s.data}
              dataKey="v"
              type="monotone"
              stroke={s.color}
              strokeWidth={2}
              strokeDasharray={s.dashed ? '6 4' : undefined}
              dot={false}
              isAnimationActive={false}
            />
          ))}
          {refLines.map((r) => (
            <ReferenceLine
              key={r.label}
              y={r.y}
              stroke={r.color}
              strokeDasharray="4 4"
              label={{ value: r.label, fontSize: 10, fill: r.color, position: 'insideBottomRight' }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------

const BOUND_COLORS: Record<string, string> = {
  h1_high: '#38bdf8', // sky
  h1_low: '#fb923c',  // orange
  nominal: '#a78bfa', // violet
};

function boundDisplayName(r: TankFreezeBoundResult): string {
  if (r.bound_label === 'h1_high') return `h1 x${r.h1_multiplier} (freeze-time bound)`;
  if (r.bound_label === 'h1_low') return `h1 x${r.h1_multiplier} (thickness bound)`;
  return 'nominal h1';
}

function fmtMinutes(s: number | null): string {
  if (s === null) return '—';
  return (s / 60).toFixed(1);
}

export function TankFreeze() {
  // Fluids
  const [fluidInner, setFluidInner] = useState<TankFreezeFluid>('ethanol');
  const [fluidOuter, setFluidOuter] = useState<TankFreezeFluid>('lox');
  // Geometry
  const [rIIn, setRIIn] = useState('3.94'); // inches (~0.10 m)
  const [wallMm, setWallMm] = useState('3.0');
  const [height, setHeight] = useState('1.0');
  const [rTankIn, setRTankIn] = useState('6.0'); // outer tank radius, inches
  // Conditions
  const [pTankPsi, setPTankPsi] = useState('14.7');
  const [pFuelPsi, setPFuelPsi] = useState('14.7');
  const [tEth0, setTEth0] = useState('293');
  const [mLiq0, setMLiq0] = useState('24.6');

  // Resolved roles: in mixed combos the lower-sinkRank fluid is the boiling
  // fixed-T sink; the other is the freezable bulk. Sections set geometry only.
  const roles = useMemo(() => {
    const same = fluidInner === fluidOuter;
    const sinkIsInner = !same && FLUID_INFO[fluidInner].sinkRank < FLUID_INFO[fluidOuter].sinkRank;
    const bulk: TankFreezeFluid = same ? fluidInner : sinkIsInner ? fluidOuter : fluidInner;
    const sink: TankFreezeFluid = same ? fluidInner : sinkIsInner ? fluidInner : fluidOuter;
    return { same, bulk, sink, bulkInside: same || bulk === fluidInner };
  }, [fluidInner, fluidOuter]);
  const bulkLabel = FLUID_INFO[roles.bulk].label;
  const sinkLabel = FLUID_INFO[roles.sink].label;

  // When the bulk fluid changes, refresh its temperature and material defaults
  const prevBulk = useRef(roles.bulk);
  useEffect(() => {
    if (prevBulk.current === roles.bulk) return;
    prevBulk.current = roles.bulk;
    const info = FLUID_INFO[roles.bulk];
    setTEth0(info.defaultT0);
    setKS(info.materials.kS);
    setRhoS(info.materials.rhoS);
    setCpS(info.materials.cpS);
    setLFus(info.materials.lFus);
    setTFr(info.materials.tFr);
  }, [roles.bulk]);
  // Run controls
  const [missionMin, setMissionMin] = useState('20');
  const [solidifyMaxMin, setSolidifyMaxMin] = useState('180');
  // Thresholds (optional, blank = off)
  const [muPumpMaxMpas, setMuPumpMaxMpas] = useState('');
  const [iceMaxMm, setIceMaxMm] = useState('');
  // Conservatism
  const [boundMode, setBoundMode] = useState<'both' | 'freeze_time' | 'nominal'>('both');
  const [h1High, setH1High] = useState('1.25');
  const [h1Low, setH1Low] = useState('0.75');
  // Advanced / material
  const [deltaSeed, setDeltaSeed] = useState('0.00001');
  const [rMin, setRMin] = useState('0.0001');
  const [plotPoints, setPlotPoints] = useState('400');
  const [kS, setKS] = useState('0.5');
  const [rhoS, setRhoS] = useState('1025');
  const [cpS, setCpS] = useState('1200');
  const [lFus, setLFus] = useState('105000');
  const [tFr, setTFr] = useState('159');
  const [kAl, setKAl] = useState('167');
  const [loxChf, setLoxChf] = useState('');

  // Run state
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressInfo, setProgressInfo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<TankFreezeBoundResult[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const estimateMass = useCallback(() => {
    const ri = parseFloat(rIIn) * 0.0254; // in -> m
    const h = parseFloat(height);
    const t = parseFloat(tEth0);
    if (!isFinite(ri) || !isFinite(h) || !isFinite(t)) return;
    const rho = FLUID_INFO[roles.bulk].rho(t);
    if (roles.bulkInside) {
      setMLiq0((rho * Math.PI * ri * ri * h).toFixed(2));
    } else {
      const rw = ri + (parseFloat(wallMm) || 0) * 1e-3;
      const rt = parseFloat(rTankIn) * 0.0254;
      if (!isFinite(rt) || rt <= rw) return;
      setMLiq0((rho * Math.PI * (rt * rt - rw * rw) * h).toFixed(2));
    }
  }, [rIIn, height, tEth0, wallMm, rTankIn, roles]);

  const handleRun = useCallback(() => {
    setError(null);
    const req: TankFreezeRequest = {
      r_i: parseFloat(rIIn) * 0.0254, // in -> m
      wall_thickness_mm: parseFloat(wallMm),
      H: parseFloat(height),
      fluid_inner: fluidInner,
      fluid_outer: fluidOuter,
      r_tank_outer_m: !roles.bulkInside ? parseFloat(rTankIn) * 0.0254 : null,
      P_tank_pa: parseFloat(pTankPsi) * 6894.757,
      P_fuel_pa: pFuelPsi !== '' ? parseFloat(pFuelPsi) * 6894.757 : null,
      T_eth0: parseFloat(tEth0),
      m_liq0: parseFloat(mLiq0),
      t_mission_min: parseFloat(missionMin),
      t_solidify_max_min: parseFloat(solidifyMaxMin),
      delta_seed: parseFloat(deltaSeed),
      r_min: parseFloat(rMin),
      plot_points: parseInt(plotPoints, 10),
      mu_pump_max: muPumpMaxMpas !== '' ? parseFloat(muPumpMaxMpas) * 1e-3 : null,
      delta_ice_max: iceMaxMm !== '' ? parseFloat(iceMaxMm) * 1e-3 : null,
      bound_mode: boundMode,
      h1_high: parseFloat(h1High),
      h1_low: parseFloat(h1Low),
      k_s: parseFloat(kS),
      rho_s: parseFloat(rhoS),
      c_p_s: parseFloat(cpS),
      L_fus: parseFloat(lFus),
      T_fr: parseFloat(tFr),
      k_Al: parseFloat(kAl),
      lox_chf: loxChf !== '' ? parseFloat(loxChf) : null,
    };

    const required: [string, number][] = [
      ['Inner radius', req.r_i],
      ['Wall thickness', req.wall_thickness_mm],
      ['Height', req.H],
      ['Tank pressure', req.P_tank_pa],
      ['Initial temperature', req.T_eth0],
      ['Liquid mass', req.m_liq0],
      ['Mission time', req.t_mission_min],
    ];
    for (const [name, v] of required) {
      if (!isFinite(v) || v <= 0) {
        setError(`${name} must be a positive number.`);
        return;
      }
    }
    if (!roles.bulkInside) {
      const rt = req.r_tank_outer_m ?? NaN;
      const rw = req.r_i + req.wall_thickness_mm * 1e-3;
      if (!isFinite(rt) || rt <= rw) {
        setError('Outer tank radius must exceed the inner radius plus the wall thickness.');
        return;
      }
    }

    setIsRunning(true);
    setProgress(0);
    setProgressInfo('Starting...');
    setResults(null);

    abortRef.current = runTankFreezeStream(
      req,
      (event) => {
        if (event.type === 'status') {
          setProgressInfo(event.message ?? '');
        } else if (event.type === 'progress') {
          setProgress(event.progress ?? 0);
          const simMin = ((event.sim_time_s ?? 0) / 60).toFixed(1);
          setProgressInfo(`${event.bound ?? ''} — sim time ${simMin} min`);
        } else if (event.type === 'complete') {
          setProgress(1);
          setResults(event.results ?? []);
          setIsRunning(false);
        } else if (event.type === 'error') {
          setError(event.error ?? 'Simulation failed');
          setIsRunning(false);
        }
      },
      (err) => {
        setError(err);
        setIsRunning(false);
      }
    );
  }, [
    rIIn, wallMm, height, pTankPsi, pFuelPsi, tEth0, mLiq0, missionMin, solidifyMaxMin,
    deltaSeed, rMin, plotPoints, muPumpMaxMpas, iceMaxMm, boundMode,
    h1High, h1Low, kS, rhoS, cpS, lFus, tFr, kAl, loxChf,
    fluidInner, fluidOuter, rTankIn, roles,
  ]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    setIsRunning(false);
    setProgressInfo('Cancelled');
  }, []);

  // ------------------------------------------------------------------ charts
  const charts = useMemo(() => {
    if (!results || results.length === 0) return null;

    const mk = (
      pick: (r: TankFreezeBoundResult, i: number) => number,
      scale = 1
    ): ((r: TankFreezeBoundResult) => SeriesDef) =>
      (r) => ({
        name: boundDisplayName(r),
        color: BOUND_COLORS[r.bound_label] ?? '#a78bfa',
        data: r.t_s.map((t, i) => ({ t: t / 60, v: pick(r, i) * scale })),
      });

    const iceSeries = results.map(mk((r, i) => r.ice_thickness_m[i], 1e3));
    const tempSeries = results.map(mk((r, i) => r.T_eth_K[i]));
    const muSeries = results.map(mk((r, i) => r.mu_eth_Pa_s[i], 1e3));
    const h1Series = results.map(mk((r, i) => r.h1_W_m2K[i]));
    const wallSeries = results.map(mk((r, i) => r.T_w_K[i]));
    const qLoxSeries = results.map(mk((r, i) => r.q_lox_W_m2[i]));

    const heatSeries: SeriesDef[] = results.flatMap((r) => [
      {
        name: `Qout — ${boundDisplayName(r)}`,
        color: BOUND_COLORS[r.bound_label] ?? '#a78bfa',
        data: r.t_s.map((t, i) => ({ t: t / 60, v: r.Qout_W[i] })),
      },
      {
        name: `Qin — ${boundDisplayName(r)}`,
        color: BOUND_COLORS[r.bound_label] ?? '#a78bfa',
        dashed: true,
        data: r.t_s.map((t, i) => ({ t: t / 60, v: r.Qin_W[i] })),
      },
    ]);

    const iceRefs: RefLineDef[] = [];
    for (const r of results) {
      if (r.delta_eq_m !== null) {
        iceRefs.push({
          y: r.delta_eq_m * 1e3,
          label: `δ_eq (${r.bound_label})`,
          color: BOUND_COLORS[r.bound_label] ?? '#a78bfa',
        });
      }
    }
    if (iceMaxMm !== '' && isFinite(parseFloat(iceMaxMm))) {
      iceRefs.push({ y: parseFloat(iceMaxMm), label: 'max allowed', color: '#ef4444' });
    }

    const muRefs: RefLineDef[] =
      muPumpMaxMpas !== '' && isFinite(parseFloat(muPumpMaxMpas))
        ? [{ y: parseFloat(muPumpMaxMpas), label: 'pump limit', color: '#ef4444' }]
        : [];

    const chfRefs: RefLineDef[] = results.length
      ? [{ y: results[0].lox_chf_W_m2, label: 'LOX CHF', color: '#ef4444' }]
      : [];

    return { iceSeries, tempSeries, muSeries, h1Series, wallSeries, qLoxSeries, heatSeries, iceRefs, muRefs, chfRefs };
  }, [results, iceMaxMm, muPumpMaxMpas]);

  // Conservative headline numbers = worst case across bounds
  const summary = useMemo(() => {
    if (!results || results.length === 0) return null;
    const ices = results.filter((r) => r.ice_at_mission_m !== null);
    const sols = results.filter((r) => r.t_solidify_s !== null);
    const mus = results.filter((r) => r.t_mu_cross_s !== null);
    const iceCross = results.filter((r) => r.t_ice_cross_s !== null);
    const overallClass = results.some((r) => r.classification === 'NO_HEAT_FLOW')
      ? 'NO_HEAT_FLOW'
      : results.some((r) => r.classification === 'NO_FREEZING')
        ? 'NO_FREEZING'
        : results.some((r) => r.classification === 'UNBOUNDED')
          ? 'UNBOUNDED'
          : 'BOUNDED';
    return {
      overallClass,
      anyUnbounded: results.some((r) => r.classification === 'UNBOUNDED'),
      maxIceAtMission: ices.length ? Math.max(...ices.map((r) => r.ice_at_mission_m as number)) : null,
      minSolidify: sols.length ? Math.min(...sols.map((r) => r.t_solidify_s as number)) : null,
      allSolidifyCapped: results.every((r) => r.solidify_capped),
      minMuCross: mus.length ? Math.min(...mus.map((r) => r.t_mu_cross_s as number)) : null,
      minIceCross: iceCross.length ? Math.min(...iceCross.map((r) => r.t_ice_cross_s as number)) : null,
      maxMuAtMission: Math.max(...results.map((r) => r.mu_at_mission_Pa_s ?? 0)),
      muStart: results[0].mu_eth_Pa_s[0] ?? null,
      minTethAtMission: Math.min(...results.map((r) => r.T_eth_at_mission_K ?? Infinity)),
      maxEnergyErr: Math.max(...results.map((r) => Math.abs(r.energy_balance_error_pct))),
      tLox: results[0].T_LOX_K,
    };
  }, [results]);

  const uniqueFlags = useMemo(() => {
    if (!results) return [];
    const seen = new Map<string, string[]>();
    for (const r of results) {
      for (const f of r.flags) {
        const arr = seen.get(f) ?? [];
        arr.push(r.bound_label);
        seen.set(f, arr);
      }
    }
    return Array.from(seen.entries()).map(([flag, bounds]) => ({
      flag,
      bounds: results.length > 1 && bounds.length < results.length ? bounds.join(', ') : null,
    }));
  }, [results]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-bold text-[var(--color-text-primary)]">
          Ethanol/LOX Tank Freeze
        </h2>
        <p className="text-sm text-[var(--color-text-secondary)] mt-1">
          Transient freezing across the common wall of a concentric tank (ethanol, LOX, or
          liquid methane in either section): Stefan front growth, bulk cool-down, and viscosity
          rise. The colder-boiling fluid acts as the fixed-temperature sink. Runs conservative
          h1 bounds — freeze-time numbers from the h1-high run, thickness from the worst case.
        </p>
      </div>

      {/* Inputs */}
      <div className="space-y-3">
        <CollapsibleSection
          title="Tank Geometry & Conditions"
          defaultExpanded
          icon={
            <svg className="w-5 h-5 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375" />
            </svg>
          }
        >
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
            <div>
              <label className="block text-sm text-[var(--color-text-secondary)] mb-1">Inner section fluid</label>
              <select
                value={fluidInner}
                onChange={(e) => setFluidInner(e.target.value as TankFreezeFluid)}
                className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] focus:outline-none focus:border-sky-500"
              >
                <option value="ethanol">Ethanol</option>
                <option value="lox">LOX</option>
                <option value="methane">Methane (liquid)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-[var(--color-text-secondary)] mb-1">Outer section fluid</label>
              <select
                value={fluidOuter}
                onChange={(e) => setFluidOuter(e.target.value as TankFreezeFluid)}
                className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] focus:outline-none focus:border-sky-500"
              >
                <option value="ethanol">Ethanol</option>
                <option value="lox">LOX</option>
                <option value="methane">Methane (liquid)</option>
              </select>
            </div>
            <div className="flex items-end pb-1">
              <p className="text-xs text-[var(--color-text-muted)]">
                {roles.same
                  ? 'Identical fluids → ΔT = 0; the run will show zero heat flow.'
                  : `${sinkLabel} boils colder, so it is the fixed-T sink; ${bulkLabel} (${roles.bulkInside ? 'inner' : 'outer'} section) is the bulk that cools${roles.bulk === 'methane' && roles.sink === 'lox' ? '. Methane freezes against LOX only below ~15.5 psia; above that it cools without ice' : ' and freezes'}.`}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <InputField label="Inner section radius r_i" value={rIIn} onChange={setRIIn} unit="in" step={0.25} help="Inner fluid / wall interface" />
            <InputField label="Wall thickness" value={wallMm} onChange={setWallMm} unit="mm" step={0.5} help="Common wall between the fluids" />
            <InputField label="Wetted height H" value={height} onChange={setHeight} unit="m" step={0.05} help="Little effect on results for a full tank (scales out)" />
            {!roles.bulkInside && (
              <InputField label="Outer tank radius" value={rTankIn} onChange={setRTankIn} unit="in" step={0.25} help={`Outer wall bounding the ${bulkLabel} annulus`} />
            )}
            <InputField label={`Sink pressure (${sinkLabel} side)`} value={pTankPsi} onChange={setPTankPsi} unit="psi" step={1} help={`Absolute; sets T_sink = T_sat(P) of ${sinkLabel}. 14.7 = vented`} />
            <InputField label={`Fuel pressure (${bulkLabel} side)`} value={pFuelPsi} onChange={setPFuelPsi} unit="psi" step={10} help={`Absolute; elevates T_fr ~0.02-0.04 K/bar (Clausius-Clapeyron)${roles.bulk === 'methane' ? ' — decisive for methane vs LOX' : ''}`} />
            <InputField label={`Initial ${bulkLabel.toLowerCase()} temp`} value={tEth0} onChange={setTEth0} unit="K" step={1} />
            <div>
              <InputField label="Initial liquid mass" value={mLiq0} onChange={setMLiq0} unit="kg" step={0.1} />
              <button
                onClick={estimateMass}
                disabled={roles.same}
                className="mt-1 text-xs text-sky-400 hover:text-sky-300 transition-colors disabled:opacity-40"
              >
                Estimate from geometry (full tank)
              </button>
            </div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="Run Controls & Thresholds"
          defaultExpanded
          icon={
            <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        >
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <InputField label="Mission time" value={missionMin} onChange={setMissionMin} unit="min" step={1} help="Sim horizon for the main run" />
            <InputField label="Solidify search horizon" value={solidifyMaxMin} onChange={setSolidifyMaxMin} unit="min" step={10} help="Extension when ice is still growing" />
            <InputField label="Max pump viscosity" value={muPumpMaxMpas} onChange={setMuPumpMaxMpas} unit="mPa·s" step={1} help="Optional feed-system limit" />
            <InputField label="Max ice thickness" value={iceMaxMm} onChange={setIceMaxMm} unit="mm" step={1} help="Optional tolerance" />
          </div>
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4 items-end">
            <div>
              <label className="block text-sm text-[var(--color-text-secondary)] mb-1">Conservatism bounds</label>
              <select
                value={boundMode}
                onChange={(e) => setBoundMode(e.target.value as typeof boundMode)}
                className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] focus:outline-none focus:border-sky-500"
              >
                <option value="both">Both bounds (recommended)</option>
                <option value="freeze_time">Freeze-time only (h1 high)</option>
                <option value="nominal">Nominal (no bias)</option>
              </select>
            </div>
            <InputField label="h1 high factor" value={h1High} onChange={setH1High} unit="×" step={0.05} disabled={boundMode === 'nominal'} help="Freeze-time bound bias" />
            <InputField label="h1 low factor" value={h1Low} onChange={setH1Low} unit="×" step={0.05} disabled={boundMode !== 'both'} help="Thickness bound bias" />
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="Advanced (numerics & material constants)"
          icon={
            <svg className="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
            </svg>
          }
        >
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <InputField label="Seed ice thickness" value={deltaSeed} onChange={setDeltaSeed} unit="m" help="t=0 singularity guard" />
            <InputField label="Front radius floor" value={rMin} onChange={setRMin} unit="m" />
            <InputField label="Plot points" value={plotPoints} onChange={setPlotPoints} unit="pts" step={50} />
            <InputField label="LOX CHF override" value={loxChf} onChange={setLoxChf} unit="W/m²" help="Blank = Zuber correlation" />
            <InputField label="Ice conductivity k_s" value={kS} onChange={setKS} unit="W/mK" step={0.05} help={`Frozen ${bulkLabel.toLowerCase()}; high side is conservative`} />
            <InputField label="Ice density ρ_s" value={rhoS} onChange={setRhoS} unit="kg/m³" step={5} />
            <InputField label="Ice specific heat c_p,s" value={cpS} onChange={setCpS} unit="J/kgK" step={50} />
            <InputField label="Latent heat L_fus" value={lFus} onChange={setLFus} unit="J/kg" step={1000} />
            <InputField label="Freezing point T_fr" value={tFr} onChange={setTFr} unit="K" step={0.5} />
            <InputField label="Wall conductivity k_Al" value={kAl} onChange={setKAl} unit="W/mK" step={5} />
          </div>
        </CollapsibleSection>
      </div>

      {/* Run / progress */}
      <div className="flex items-center gap-4">
        <button
          onClick={isRunning ? handleCancel : handleRun}
          className={`px-6 py-2.5 rounded-lg font-medium transition-colors ${
            isRunning
              ? 'bg-red-600 hover:bg-red-700 text-white'
              : 'bg-sky-600 hover:bg-sky-700 text-white'
          }`}
        >
          {isRunning ? 'Cancel' : 'Run Simulation'}
        </button>
        {(isRunning || progress > 0) && (
          <div className="flex-1 max-w-xl">
            <div className="flex justify-between text-xs text-[var(--color-text-secondary)] mb-1">
              <span>{progressInfo}</span>
              <span>{Math.round(progress * 100)}%</span>
            </div>
            <div className="w-full h-2 bg-[var(--color-bg-tertiary)] rounded-full overflow-hidden">
              <div
                className="h-full bg-sky-500 transition-all duration-200"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm whitespace-pre-wrap">
          {error}
        </div>
      )}

      {/* Results */}
      {results && summary && charts && (
        <div className="space-y-6">
          {/* Configuration caption */}
          {results.length > 0 && (
            <p className="text-sm text-[var(--color-text-secondary)]">
              {results[0].mode === 'no_heat_flow'
                ? `Both sections contain ${FLUID_INFO[results[0].bulk_fluid].label.toLowerCase()} — no temperature difference, no heat flow.`
                : `${FLUID_INFO[results[0].bulk_fluid].label} (${results[0].bulk_inside ? 'inner core' : 'outer annulus'}) ${results[0].mode === 'cooling' ? 'cooling toward' : `freezing ${results[0].bulk_inside ? 'inward' : 'outward'} against`} boiling ${FLUID_INFO[results[0].sink_fluid].label} (${results[0].bulk_inside ? 'outer' : 'inner'} section) at ${results[0].T_LOX_K.toFixed(1)} K.`}
            </p>
          )}
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <MetricCard
              label="Classification"
              value={summary.overallClass.replace(/_/g, ' ')}
              unit=""
              color={
                summary.overallClass === 'UNBOUNDED' ? 'red'
                  : summary.overallClass === 'BOUNDED' ? 'green'
                    : summary.overallClass === 'NO_FREEZING' ? 'blue' : 'gray'
              }
              subValue={
                summary.overallClass === 'UNBOUNDED' ? 'Ice still growing at mission end'
                  : summary.overallClass === 'BOUNDED' ? 'Ice plateaus near equilibrium'
                    : summary.overallClass === 'NO_FREEZING' ? 'Sink is warmer than the freezing point'
                      : 'Identical fluids — zero heat flux'
              }
            />
            <MetricCard
              label="Equilibrium ice δ_eq @ T₀"
              value={
                results
                  .map((r) => (r.delta_eq_m === null ? 'none' : (r.delta_eq_m * 1e3).toFixed(2)))
                  .join(' / ')
              }
              unit="mm"
              color="blue"
              subValue={
                results.map((r) => r.bound_label).join(' / ') +
                ' — hypothetical stall if bulk held its initial temp; transient curves are the real prediction'
              }
            />
            <MetricCard
              label={`Ice @ ${missionMin} min (worst)`}
              value={summary.maxIceAtMission !== null ? (summary.maxIceAtMission * 1e3).toFixed(2) : '—'}
              unit="mm"
              color="orange"
              subValue={
                summary.minIceCross !== null
                  ? `Crosses limit at ${fmtMinutes(summary.minIceCross)} min`
                  : undefined
              }
            />
            <MetricCard
              label="Time to solidify (worst)"
              value={
                summary.minSolidify !== null
                  ? fmtMinutes(summary.minSolidify)
                  : summary.allSolidifyCapped
                    ? `> ${solidifyMaxMin}`
                    : '—'
              }
              unit="min"
              color="red"
              subValue="Conservative: earliest bound"
            />
            <MetricCard
              label={`Viscosity @ ${missionMin} min (worst)`}
              value={(summary.maxMuAtMission * 1e3).toFixed(1)}
              unit="mPa·s"
              color="purple"
              subValue={
                (summary.muStart !== null
                  ? `started at ${(summary.muStart * 1e3).toFixed(2)} mPa·s (${(summary.maxMuAtMission / summary.muStart).toFixed(1)}× rise)`
                  : '') +
                (summary.minMuCross !== null
                  ? `; pump limit hit at ${fmtMinutes(summary.minMuCross)} min`
                  : '')
              }
            />
            <MetricCard
              label="T_sink / energy closure"
              value={summary.tLox.toFixed(1)}
              unit="K"
              color="green"
              subValue={`Energy balance |err| ≤ ${summary.maxEnergyErr.toFixed(2)}%`}
            />
          </div>

          {/* Warnings */}
          {uniqueFlags.length > 0 && (
            <div className="p-4 rounded-lg bg-yellow-500/5 border border-yellow-500/20">
              <h4 className="text-sm font-medium text-yellow-400 mb-2">Model checks & warnings</h4>
              <ul className="space-y-1.5">
                {uniqueFlags.map(({ flag, bounds }, i) => (
                  <li key={i} className="text-xs text-[var(--color-text-secondary)] flex gap-2">
                    <span className="text-yellow-500 shrink-0">▸</span>
                    <span>
                      {flag}
                      {bounds && <span className="text-[var(--color-text-muted)]"> [{bounds}]</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Charts */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <ChartCard
              title="Ice thickness"
              yLabel="δ_ice (mm)"
              series={charts.iceSeries}
              refLines={charts.iceRefs}
              valueFormatter={(v) => `${v.toFixed(2)} mm`}
            />
            <ChartCard
              title="Heat flow at the freeze front (Qout solid, Qin dashed)"
              yLabel="Q (W)"
              series={charts.heatSeries}
              valueFormatter={(v) => `${v.toFixed(0)} W`}
            />
            <ChartCard
              title={`Bulk ${FLUID_INFO[results[0].bulk_fluid].label.toLowerCase()} temperature`}
              yLabel="T_bulk (K)"
              series={charts.tempSeries}
              refLines={[{ y: parseFloat(tFr) || 159, label: 'T_fr', color: '#ef4444' }]}
              valueFormatter={(v) => `${v.toFixed(1)} K`}
            />
            <ChartCard
              title={`Liquid ${FLUID_INFO[results[0].bulk_fluid].label.toLowerCase()} viscosity (log scale)`}
              yLabel="μ (mPa·s)"
              series={charts.muSeries}
              refLines={charts.muRefs}
              logScale
              valueFormatter={(v) => `${v.toFixed(2)} mPa·s`}
            />
            <ChartCard
              title="Natural-convection coefficient"
              yLabel="h1 (W/m²K)"
              series={charts.h1Series}
              valueFormatter={(v) => `${v.toFixed(1)} W/m²K`}
            />
            <ChartCard
              title={`${FLUID_INFO[results[0].sink_fluid].label}-side wall heat flux vs critical heat flux`}
              yLabel="q″ (W/m²)"
              series={charts.qLoxSeries}
              refLines={charts.chfRefs}
              valueFormatter={(v) => `${v.toExponential(2)} W/m²`}
            />
            <ChartCard
              title="Wall temperature (outer wall, derived)"
              yLabel="T_w (K)"
              series={charts.wallSeries}
              valueFormatter={(v) => `${v.toFixed(2)} K`}
            />
            <ChartCard
              title={`Remaining liquid ${FLUID_INFO[results[0].bulk_fluid].label.toLowerCase()} mass`}
              yLabel="m_liq (kg)"
              series={results.map((r) => ({
                name: boundDisplayName(r),
                color: BOUND_COLORS[r.bound_label] ?? '#a78bfa',
                data: r.t_s.map((t, i) => ({ t: t / 60, v: r.m_liq_kg[i] })),
              }))}
              valueFormatter={(v) => `${v.toFixed(2)} kg`}
            />
          </div>
        </div>
      )}
    </div>
  );
}
