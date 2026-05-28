import { useState, useEffect, useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import {
  runLayer1Optimization,
  getLayer1Status,
  getChamberGeometry,
  stopLayer1Optimization,
  getConfig,
  updateConfig,
} from '../api/client';
import type {
  Layer1Settings,
  Layer1ProgressEvent,
  Layer1Results,
  DesignRequirements,
  ChamberGeometryResponse,
  SaveDesignRequirementsResponse,
} from '../api/client';
import { ChamberContourPlot } from './ChamberContourPlot';
import { stableStringify } from '../utils/stableStringify';

/** Fill missing Design Requirements keys only; never overwrite user-saved values. */
function withDefaults(user: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...user };
  for (const [k, v] of Object.entries(defaults)) {
    const cur = out[k];
    if (cur === undefined || cur === null || (typeof cur === 'number' && !Number.isFinite(cur))) {
      out[k] = v;
    }
  }
  return out;
}

const IMPINGING_BASELINE_DEFAULTS: Record<string, unknown> = {
  max_chamber_outer_diameter: 0.2032,
  max_nozzle_exit_diameter: 0.2032,
  layer1_stagnation_pressure_frac_min: 0.65,
  layer1_stagnation_pressure_frac_max: 0.95,
  layer1_expansion_ratio_min: 3.0,
  layer1_expansion_ratio_max: 14.0,
  injector_dp_ratio_O_min: 0.15,
  injector_dp_ratio_O_max: 0.35,
  injector_dp_ratio_F_min: 0.15,
  injector_dp_ratio_F_max: 0.35,
  layer1_W_THRUST: 6.0e4,
  layer1_W_OF: 2.0e4,
  layer1_W_OF_low_MR_scale: 1.0,
  layer1_W_OF_high_MR_scale: 1.0,
  W_MOM: 2400.0,
  impinging_momentum_R_min: 0.8,
  impinging_momentum_R_max: 1.2,
  W_DP: 500.0,
  W_DP_O: 1000.0,
  W_DP_F: 1000.0,
  W_DP_HIGH: 8000.0,
  W_IMPINGING_ANGLE: 400.0,
  layer1_impinging_angle_deg_min: 55.0,
  layer1_impinging_angle_deg_max: 90.0,
  W_IMPINGING_JET_ASYM: 180.0,
  layer1_impinging_jet_angle_max_asym_deg: 26.0,
  layer1_exit_pressure_inside_quad_scale: 0.38,
  W_SMD: 0.0,
  W_CHAMBER_SHAPE: 2500.0,
  layer1_chamber_dt_ratio_min: 2.2,
  layer1_chamber_dt_ratio_max: 3.2,
  layer1_chamber_ld_ratio_min: 1.6,
  layer1_chamber_ld_ratio_max: 3.2,
  target_smd_microns: 50.0,
  layer1_smd_rel_tol: 0.20,
};

const IMPINGING_FROZEN_RESETS: Record<string, unknown> = {
  D_chamber_outer_mm: null,
  A_throat_mm2: null,
  Lstar_mm: null,
  expansion_ratio: null,
  P_O_start_psi: null,
  P_F_start_psi: null,
  d_pintle_tip_mm: null,
  h_gap_mm: null,
  n_orifices: null,
  d_orifice_mm: null,
};

interface Layer1OptimizationProps {
  requirements: DesignRequirements;
  isDirty: boolean;
  saveRequirementsToServer: (
    reqs: DesignRequirements
  ) => Promise<{ error?: string; data?: SaveDesignRequirementsResponse }>;
}

/** Avoid rounding small objectives to "0.000" when magnitude is below ~0.05 (card matches log-scaled convergence plot). */
function formatLayer1ResidualScalar(best: number): string {
  if (!Number.isFinite(best)) return String(best);
  if (best === 0) return '0';
  const ax = Math.abs(best);
  if (ax >= 100) return best.toFixed(2);
  if (ax >= 10) return best.toFixed(3);
  if (ax >= 0.05) return best.toFixed(4);
  if (ax >= 1e-4) return best.toExponential(4);
  return best.toExponential(3);
}

// Helper component for result cards
function ResultCard({
  label,
  value,
  unit,
  decimals = 2,
  color = 'blue',
  isText = false,
  footnote,
}: {
  label: string;
  value: number | string | undefined;
  unit?: string;
  decimals?: number;
  color?: string;
  isText?: boolean;
  /** Small secondary line (e.g. log10 caption when objective is tiny vs log-scaled chart). */
  footnote?: string;
}) {
  const colorClasses: Record<string, string> = {
    blue: 'bg-blue-500/10 border-blue-500/30',
    green: 'bg-green-500/10 border-green-500/30',
    yellow: 'bg-yellow-500/10 border-yellow-500/30',
    red: 'bg-red-500/10 border-red-500/30',
    purple: 'bg-purple-500/10 border-purple-500/30',
    orange: 'bg-orange-500/10 border-orange-500/30',
    cyan: 'bg-cyan-500/10 border-cyan-500/30',
    pink: 'bg-pink-500/10 border-pink-500/30',
    indigo: 'bg-indigo-500/10 border-indigo-500/30',
  };

  const textColorClasses: Record<string, string> = {
    blue: 'text-blue-400',
    green: 'text-green-400',
    yellow: 'text-yellow-400',
    red: 'text-red-400',
    purple: 'text-purple-400',
    orange: 'text-orange-400',
    cyan: 'text-cyan-400',
    pink: 'text-pink-400',
    indigo: 'text-indigo-400',
  };

  const displayValue = isText
    ? String(value || '-')
    : typeof value === 'number'
      ? value.toFixed(decimals)
      : value !== undefined && value !== null
        ? String(value)
        : '-';

  return (
    <div className={`rounded-lg p-3 border ${colorClasses[color] || colorClasses.blue}`}>
      <p className="text-xs text-[var(--color-text-secondary)] mb-1">{label}</p>
      <p className={`text-lg font-bold ${textColorClasses[color] || textColorClasses.blue}`}>
        {displayValue}
        {unit && <span className="text-sm font-normal text-[var(--color-text-secondary)] ml-1">{unit}</span>}
      </p>
      {footnote ? (
        <p className="text-[11px] leading-snug mt-1.5 font-mono text-[var(--color-text-secondary)]">{footnote}</p>
      ) : null}
    </div>
  );
}

// Helper component for validation cards
function ValidationCard({ label, passed }: { label: string; passed: boolean | undefined }) {
  const isPassed = passed === true;
  const isUnknown = passed === undefined;
  return (
    <div
      className={`rounded-lg p-3 border ${
        isUnknown
          ? 'bg-slate-500/10 border-slate-500/30'
          : isPassed
            ? 'bg-green-500/10 border-green-500/30'
            : 'bg-red-500/10 border-red-500/30'
      }`}
    >
      <p className="text-xs text-[var(--color-text-secondary)] mb-1">{label}</p>
      <p
        className={`text-lg font-bold ${
          isUnknown ? 'text-slate-400' : isPassed ? 'text-green-400' : 'text-red-400'
        }`}
      >
        {isUnknown ? '—' : isPassed ? '✓ PASS' : '✗ FAIL'}
      </p>
    </div>
  );
}

// Helper component for geometry results table
function GeometryTable({ geometry }: { geometry: Record<string, any> }) {
  const injectorType =
    typeof geometry.injector_type === 'string' ? String(geometry.injector_type).toLowerCase() : '';
  const baseParams = [
    { key: 'A_throat', label: 'Throat Area', unit: 'mm²', scale: 1e6, decimals: 2 },
    { key: 'Lstar', label: 'Characteristic Length (L*)', unit: 'mm', scale: 1000, decimals: 1 },
    { key: 'chamber_length', label: 'Chamber Length', unit: 'mm', scale: 1000, decimals: 1 },
    { key: 'chamber_diameter', label: 'Chamber Inner Diameter', unit: 'mm', scale: 1000, decimals: 1 },
    { key: 'A_exit', label: 'Exit Area', unit: 'mm²', scale: 1e6, decimals: 2 },
    { key: 'expansion_ratio', label: 'Expansion Ratio', unit: '', scale: 1, decimals: 2 },
  ];

  const pintleParams = [
    { key: 'd_pintle_tip', label: 'Pintle Tip Diameter', unit: 'mm', scale: 1000, decimals: 2 },
    { key: 'h_gap', label: 'Pintle Gap Height', unit: 'mm', scale: 1000, decimals: 3 },
    { key: 'n_orifices', label: 'Number of Orifices', unit: '', scale: 1, decimals: 0 },
    { key: 'd_orifice', label: 'Orifice Diameter', unit: 'mm', scale: 1000, decimals: 3 },
  ];

  const impingingParams = [
    { key: 'n_doublets', label: 'Doublet Count (paired O=F)', unit: '', scale: 1, decimals: 0 },
    { key: 'n_elements_O', label: 'LOX Elements', unit: '', scale: 1, decimals: 0 },
    { key: 'd_jet_O', label: 'LOX Jet Diameter', unit: 'mm', scale: 1000, decimals: 3 },
    { key: 'imp_angle_O', label: 'LOX Jet Angle', unit: 'deg', scale: 1, decimals: 2 },
    { key: 'spacing_O', label: 'LOX Element Spacing', unit: 'mm', scale: 1000, decimals: 3 },
    { key: 'n_elements_F', label: 'Fuel Elements', unit: '', scale: 1, decimals: 0 },
    { key: 'd_jet_F', label: 'Fuel Jet Diameter', unit: 'mm', scale: 1000, decimals: 3 },
    { key: 'imp_angle_F', label: 'Fuel Jet Angle', unit: 'deg', scale: 1, decimals: 2 },
    { key: 'spacing_F', label: 'Fuel Element Spacing', unit: 'mm', scale: 1000, decimals: 3 },
  ];

  const hasImpingingFields = injectorType === 'impinging' || [
    'd_jet_O', 'd_jet_F', 'n_elements_O', 'n_elements_F',
    'd_jet_oxidizer', 'd_jet_fuel',
  ].some((k) => geometry[k] !== undefined);
  const hasPintleFields = ['d_pintle_tip', 'h_gap', 'n_orifices', 'd_orifice'].some((k) => geometry[k] !== undefined);
  const params = [
    ...baseParams,
    ...(hasImpingingFields ? impingingParams : []),
    ...(!hasImpingingFields && hasPintleFields ? pintleParams : []),
  ];

  return (
    <div className="bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg overflow-hidden">
      <table className="w-full text-sm text-left text-[var(--color-text-primary)]">
        <thead className="text-xs text-[var(--color-text-secondary)] uppercase bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)]">
          <tr>
            <th className="px-4 py-3 font-semibold">Parameter</th>
            <th className="px-4 py-3 font-semibold text-right">Value</th>
            <th className="px-4 py-3 font-semibold">Unit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {params.map((p) => {
            const aliasMap: Record<string, string[]> = {
              d_jet_O: ['d_jet_oxidizer'],
              d_jet_F: ['d_jet_fuel'],
              imp_angle_O: ['impingement_angle_oxidizer'],
              imp_angle_F: ['impingement_angle_fuel'],
              spacing_O: ['spacing_oxidizer'],
              spacing_F: ['spacing_fuel'],
            };
            let val = geometry[p.key];
            if ((val === undefined || val === null) && aliasMap[p.key]) {
              for (const alt of aliasMap[p.key]) {
                if (geometry[alt] !== undefined && geometry[alt] !== null) {
                  val = geometry[alt];
                  break;
                }
              }
            }
            if (val === undefined || val === null) return null;
            if (typeof val === 'number' && !Number.isFinite(val)) return null;
            const displayVal = typeof val === 'number' ? (val * p.scale).toFixed(p.decimals) : val;
            return (
              <tr key={p.key} className="hover:bg-blue-500/5 transition-colors">
                <td className="px-4 py-2.5 text-[var(--color-text-secondary)]">{p.label}</td>
                <td className="px-4 py-2.5 text-right font-mono font-medium text-blue-400">{displayVal}</td>
                <td className="px-4 py-2.5 text-xs text-[var(--color-text-secondary)]">{p.unit}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Helper component for parameter convergence plots
function ParameterConvergencePlots({
  iterationHistory,
  geometry,
}: {
  iterationHistory: Array<Record<string, unknown>>;
  geometry?: Record<string, unknown>;
}) {
  // Extract parameter data
  const getVar = (h: Record<string, unknown>, key: string, xIdx: number, defaultVal: number, scale: number = 1.0): number => {
    if (h[key] !== undefined && h[key] !== null && typeof h[key] === 'number') {
      return (h[key] as number) * scale;
    } else if (h.x && Array.isArray(h.x) && h.x.length > xIdx && typeof h.x[xIdx] === 'number') {
      return (h.x[xIdx] as number) * scale;
    }
    return defaultVal * scale;
  };

  const iterations = iterationHistory.map((h, i) => (h.iteration as number | undefined) ?? i);
  const hasFiniteKey = (key: string): boolean =>
    iterationHistory.some((h) => typeof h[key] === 'number' && Number.isFinite(h[key] as number));
  const hasImpingingHistory =
    hasFiniteKey('d_jet_O') ||
    hasFiniteKey('d_jet_F') ||
    hasFiniteKey('n_elements_O') ||
    hasFiniteKey('n_elements_F') ||
    geometry?.d_jet_O !== undefined ||
    geometry?.d_jet_F !== undefined;

  // Parameter definitions: [key, label, unit, xIndex, default, scale]
  const baseParameters = [
    ['A_throat', 'Throat Area', 'mm²', 0, 0.001, 1e6],
    ['Lstar', 'L*', 'mm', 1, 1.0, 1000],
    ['expansion_ratio', 'Expansion Ratio', '', 2, 10.0, 1.0],
    ['D_chamber_outer', 'Chamber Outer Diameter', 'mm', 3, 0.1, 1000],
    ['D_chamber_inner', 'Chamber Inner Diameter', 'mm', 3, 0.1, 1000],
    ['P_O_start_psi', 'LOX Tank Pressure', 'psi', hasImpingingHistory ? 11 : 8, 500, 1.0],
    ['P_F_start_psi', 'Fuel Tank Pressure', 'psi', hasImpingingHistory ? 12 : 9, 600, 1.0],
    ['exit_diameter', 'Exit Diameter', 'mm', -1, 0.1, 1000],
  ] as const;
  const pintleParameters = [
    ['d_pintle_tip', 'Pintle Tip Diameter', 'mm', 4, 0.015, 1000],
    ['h_gap', 'Gap Height', 'mm', 5, 0.0006, 1000],
    ['n_orifices', 'Number of Orifices', '', 6, 16, 1.0],
    ['d_orifice', 'Orifice Diameter', 'mm', 7, 0.003, 1000],
  ] as const;
  const impingingParameters = [
    ['n_doublets', 'Doublet Count', '', 4, 20, 1.0],
    ['d_jet_O', 'LOX Jet Diameter', 'mm', 5, 2.0e-3, 1000],
    ['impingement_angle_O', 'LOX Impingement Angle', 'deg', 6, 30.0, 1.0],
    ['spacing_O', 'LOX Jet Spacing', 'mm', 7, 3.0e-3, 1000],
    ['d_jet_F', 'Fuel Jet Diameter', 'mm', 8, 2.0e-3, 1000],
    ['impingement_angle_F', 'Fuel Impingement Angle', 'deg', 9, 30.0, 1.0],
    ['spacing_F', 'Fuel Jet Spacing', 'mm', 10, 3.0e-3, 1000],
  ] as const;
  const parameters = [
    ...baseParameters,
    ...(hasImpingingHistory ? impingingParameters : pintleParameters),
  ] as const;

  // Extract data for each parameter
  const plotData = iterations.map((iter, idx) => {
    const h = iterationHistory[idx];
    const point: Record<string, number | string> = { iteration: iter };
    parameters.forEach(([key, , , xIdx, defaultVal, scale]) => {
      if (key === 'D_chamber_inner') {
        // Special handling for inner diameter (derived from outer)
        const outer = getVar(h, 'D_chamber_outer', 3, 0.1, 1.0);
        const inner = (h.D_chamber_inner as number) ?? (outer - 0.0254);
        point[key] = inner * 1000;
      } else if (key === 'exit_diameter') {
        // Calculate exit diameter from A_throat and expansion_ratio
        // D_exit = sqrt(4 * A_throat * expansion_ratio / pi) in meters, then convert to mm
        const A_throat_m2 = getVar(h, 'A_throat', 0, 0.001, 1.0);
        const expansion_ratio_val = getVar(h, 'expansion_ratio', 2, 10.0, 1.0);
        const D_exit_m = Math.sqrt(Math.max(0, (4 * A_throat_m2 * expansion_ratio_val) / Math.PI));
        point[key] = D_exit_m * 1000; // Convert to mm
      } else if (key === 'n_orifices' || key === 'n_doublets') {
        point[key] = Math.round(getVar(h, key, xIdx, defaultVal, scale));
      } else {
        point[key] = getVar(h, key, xIdx, defaultVal, scale);
      }
    });
    return point;
  });

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {parameters.map(([key, label, unit]) => (
        <div key={key} className="bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg p-4">
          <h5 className="text-sm font-semibold text-[var(--color-text-primary)] mb-2">
            {label} {unit && `(${unit})`}
          </h5>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={plotData} margin={{ top: 5, right: 10, left: 5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.3} />
              <XAxis
                dataKey="iteration"
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 9 }}
              />
              <YAxis
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 9 }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--color-bg-secondary)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '0.5rem',
                  fontSize: '12px'
                }}
              />
              <Line
                type="monotone"
                dataKey={key}
                stroke="#3b82f6"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ))}
    </div>
  );
}

export function Layer1Optimization({
  requirements,
  isDirty,
  saveRequirementsToServer,
}: Layer1OptimizationProps) {
  const [settings, setSettings] = useState<Layer1Settings>({
    thrust_tolerance: 0.1, // 10%
  });

  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('');
  const [message, setMessage] = useState('');
  const [results, setResults] = useState<Layer1Results | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [objectiveHistory, setObjectiveHistory] = useState<Array<{
    iteration: number;
    objective: number;
    best_objective: number;
  }>>([]);
  const [showParameterPlots, setShowParameterPlots] = useState(false);
  const [showInjectorPressures, setShowInjectorPressures] = useState(false);
  const [showSolverInputsEcho, setShowSolverInputsEcho] = useState(false);
  const [momentumRAuditOpen, setMomentumRAuditOpen] = useState(false);
  const [chamberGeometry, setChamberGeometry] = useState<ChamberGeometryResponse | null>(null);
  const [eventSourceRef, setEventSourceRef] = useState<EventSource | null>(null);
  const [activeInjectorType, setActiveInjectorType] = useState<string>('unknown');

  // Calculate min/max objective values for dot scaling
  const { minObj, maxObj } = useMemo(() => {
    if (objectiveHistory.length === 0) {
      return { minObj: 1, maxObj: 1 };
    }
    const values = objectiveHistory.map(h => h.objective).filter(v => typeof v === 'number' && isFinite(v));
    if (values.length === 0) {
      return { minObj: 1, maxObj: 1 };
    }
    return {
      minObj: Math.min(...values),
      maxObj: Math.max(...values),
    };
  }, [objectiveHistory]);

  // Custom dot renderer: lower objective value = larger dot (log-scaled)
  const renderDot = useMemo(() => {
    const minSize = 5;  // Largest dot size (for best/lowest values)
    const maxSize = 0.2;  // Smallest dot size (for worst/highest values)

    // Pre-calculate log values for efficiency
    const logMinObj = Math.log(minObj);
    const logMaxObj = Math.log(maxObj);
    const logRange = logMaxObj - logMinObj;

    return (props: any) => {
      const { cx, cy, payload } = props;
      if (!payload || typeof payload.objective !== 'number' || !isFinite(payload.objective) || payload.objective <= 0) {
        // Return invisible dot for invalid data
        return <circle cx={cx} cy={cy} r={0} fill="none" />;
      }

      if (logRange === 0 || minObj === maxObj) {
        // Check if this point represents a new best
        const isBest = payload.best_objective !== undefined &&
          typeof payload.best_objective === 'number' &&
          Math.abs(payload.objective - payload.best_objective) < 1e-10;
        const fillColor = isBest ? "#ef4444" : "#3b82f6";
        return <circle cx={cx} cy={cy} r={minSize} fill={fillColor} />;
      }

      // Log-scaled inverse: lower value gets larger size
      // Normalize using log scale: 0 = worst (max), 1 = best (min)
      const logValue = Math.log(payload.objective);
      const normalized = (logMaxObj - logValue) / logRange;
      const radius = maxSize + (minSize - maxSize) * normalized;

      // Check if this point represents a new best (objective equals best_objective)
      const isBest = payload.best_objective !== undefined &&
        typeof payload.best_objective === 'number' &&
        Math.abs(payload.objective - payload.best_objective) < 1e-10;
      const fillColor = isBest ? "#ef4444" : "#3b82f6"; // Red for best, blue for others

      return <circle cx={cx} cy={cy} r={radius} fill={fillColor} />;
    };
  }, [minObj, maxObj]);

  // Check status on mount
  useEffect(() => {
    checkStatus();
    refreshActiveInjectorType();
  }, []);

  // Cleanup EventSource on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef) {
        eventSourceRef.close();
      }
    };
  }, [eventSourceRef]);

  const checkStatus = async () => {
    const response = await getLayer1Status();
    if (response.data) {
      setIsRunning(response.data.running);
      setProgress(response.data.progress);
      setStage(response.data.stage);
      setMessage(response.data.message);
      if (response.data.error) {
        setError(response.data.error);
      }
    }
  };

  const refreshActiveInjectorType = async (): Promise<string> => {
    const cfg = await getConfig();
    const injType = String((cfg.data?.config?.injector as Record<string, unknown> | undefined)?.type ?? 'unknown').toLowerCase();
    setActiveInjectorType(injType);
    return injType;
  };

  const ensureImpingingMode = async (): Promise<boolean> => {
    const cfg = await getConfig();
    const injector = (cfg.data?.config?.injector as Record<string, unknown> | undefined) ?? {};
    const designReq = (cfg.data?.config?.design_requirements as Record<string, unknown> | undefined) ?? {};
    const frozen = (designReq.frozen_parameters as Record<string, unknown> | undefined) ?? {};
    const injectorType = String(injector.type ?? 'unknown').toLowerCase();
    const userMinLstar = Number(designReq.min_Lstar);
    const userMaxLstar = Number(designReq.max_Lstar);
    const preservedMinLstar = Number.isFinite(userMinLstar) && userMinLstar > 0 ? userMinLstar : 0.76;
    const preservedMaxLstar = Number.isFinite(userMaxLstar) && userMaxLstar > preservedMinLstar ? userMaxLstar : 1.5;
    const userNDoubletsMax = Number(designReq.layer1_impinging_n_doublets_max);
    const preservedNDoubletsMax =
      Number.isFinite(userNDoubletsMax) && userNDoubletsMax >= 5
        ? Math.round(userNDoubletsMax)
        : 20;
    // Do not treat conservative tank caps (<850 psi) as "needs baseline": users may intentionally
    // cap lower; forcing 900 here overwrote Design Requirements before every Layer 1 run.
    const needImpingingBaseline =
      Number(designReq.max_chamber_outer_diameter ?? 0) < 0.20 ||
      Number(designReq.max_nozzle_exit_diameter ?? 0) < 0.20 ||
      Number(designReq.layer1_W_OF ?? 1.0e4) > 2.0e5 ||
      frozen.d_pintle_tip_mm != null ||
      frozen.h_gap_mm != null ||
      frozen.n_orifices != null ||
      frozen.d_orifice_mm != null;

    const mergedDesignRequirements: Record<string, unknown> = {
      ...withDefaults(
        { ...(designReq as Record<string, unknown>) },
        {
          ...IMPINGING_BASELINE_DEFAULTS,
          min_Lstar: preservedMinLstar,
          max_Lstar: preservedMaxLstar,
          layer1_impinging_n_doublets_max: preservedNDoubletsMax,
        }
      ),
      frozen_parameters: {
        ...(frozen as Record<string, unknown>),
        ...IMPINGING_FROZEN_RESETS,
      },
    };

    if (injectorType === 'impinging') {
      if (needImpingingBaseline) {
        setMessage(
          'Injector is already impinging. Keeping your saved design requirements/feed settings as-is (no auto-baseline override).'
        );
      }
      setActiveInjectorType('impinging');
      return true;
    }
    const impingingUpdate: Record<string, unknown> = {
      injector: {
        ...(injector as Record<string, unknown>),
        type: 'impinging',
        geometry: {
          oxidizer: {
            n_elements: 20,
            d_jet: 0.00264,
            impingement_angle: 50.0,
            spacing: 0.006,
          },
          fuel: {
            n_elements: 20,
            d_jet: 0.00179,
            impingement_angle: 60.0,
            spacing: 0.006,
          },
        },
      },
      design_requirements: mergedDesignRequirements,
    };
    const upd = await updateConfig(impingingUpdate);
    if (upd.error) {
      setError(`Failed to auto-switch injector to impinging: ${upd.error}`);
      return false;
    }
    setActiveInjectorType('impinging');
    setMessage('Auto-switched injector mode to impinging for Layer 1 optimization.');
    return true;
  };

  const fetchChamberGeometry = async () => {
    const response = await getChamberGeometry();
    if (response.data) {
      setChamberGeometry(response.data);
    }
  };

  const handleRun = async () => {
    if (isDirty) {
      setMessage('Auto-saving Design Requirements before run...');
      const saveResp = await saveRequirementsToServer(requirements);
      if (saveResp.error) {
        setError(saveResp.error);
        setMessage('');
        return;
      }
    }

    const ready = await ensureImpingingMode();
    if (!ready) {
      return;
    }

    setIsRunning(true);
    setProgress(0);
    setStage('Initializing');
    setMessage('Starting Layer 1 optimization...');
    setError(null);
    setResults(null);
    setObjectiveHistory([]);

    const eventSource = runLayer1Optimization(
      settings,
      (event: Layer1ProgressEvent) => {
        if (event.type === 'status' || event.type === 'progress') {
          if (event.progress !== undefined) setProgress(event.progress);
          if (event.stage) setStage(event.stage);
          if (event.message) setMessage(event.message);
        } else if (event.type === 'objective') {
          // Handle real-time objective updates
          if (event.objective_history && Array.isArray(event.objective_history)) {
            setObjectiveHistory(prev => [...prev, ...(event.objective_history || [])]);
          }
        } else if (event.type === 'complete') {
          setIsRunning(false);
          setProgress(1.0);
          setStage('Complete');
          setMessage('Optimization completed successfully');
          setEventSourceRef(null); // Clear reference
          if (event.results) {
            setResults(event.results);
            // Update objective history from final results (in case we missed any)
            if (event.results.objective_history) {
              setObjectiveHistory(event.results.objective_history);
            }
            // Fetch chamber geometry for contour plot
            fetchChamberGeometry();
          }
        } else if (event.type === 'error') {
          setIsRunning(false);
          setEventSourceRef(null); // Clear reference
          // Check if this is a stop message
          if (event.error && event.error.toLowerCase().includes('stopped')) {
            setError(null); // Don't show error for user-initiated stop
            setMessage('Optimization stopped');
            setStage('Stopped');
          } else {
            setError(event.error || 'Unknown error');
            setMessage(event.error || 'Optimization failed');
          }
        }
      },
      (err: string) => {
        setIsRunning(false);
        setEventSourceRef(null); // Clear reference
        setError(err);
        setMessage('Connection error');
      }
    );

    // Store EventSource reference for stop functionality
    setEventSourceRef(eventSource);
  };

  const handleStop = async () => {
    try {
      // Close the EventSource connection
      if (eventSourceRef) {
        eventSourceRef.close();
        setEventSourceRef(null);
      }

      // Call the stop API
      await stopLayer1Optimization();

      // Update UI state
      setIsRunning(false);
      setMessage('Stopping optimization...');
      setStage('Stopped');
      setError(null);
    } catch (err) {
      console.error('Error stopping optimization:', err);
      setError('Failed to stop optimization');
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
        <div className={`mb-4 p-3 rounded-lg border ${activeInjectorType === 'impinging'
          ? 'bg-green-500/10 border-green-500/30'
          : 'bg-amber-500/10 border-amber-500/30'
          }`}>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm">
              Active injector mode: <span className="font-semibold">{activeInjectorType}</span>
              {activeInjectorType !== 'impinging' && (
                <span className="text-[var(--color-text-secondary)]"> (Layer 1 will auto-switch to impinging when you click Run)</span>
              )}
            </p>
            {activeInjectorType !== 'impinging' && (
              <button
                onClick={async () => {
                  const ok = await ensureImpingingMode();
                  if (ok) setError(null);
                }}
                className="px-3 py-1.5 text-xs rounded-md border border-amber-400/40 bg-amber-500/10 hover:bg-amber-500/20 transition-colors"
              >
                Switch To Impinging Now
              </button>
            )}
          </div>
        </div>
        <h2 className="text-2xl font-bold text-[var(--color-text-primary)] mb-2">Layer 1: Static Optimization</h2>
        <p className="text-sm text-[var(--color-text-secondary)]">
          <strong>Layer 1</strong> optimizes only <strong>static</strong> quantities:
        </p>
        <ul className="text-sm text-[var(--color-text-secondary)] list-disc list-inside mt-2 space-y-1">
          <li><strong>Engine geometry</strong>: throat area, L*, expansion ratio, active injector parameters (impinging auto-selected)</li>
          <li><strong>Initial tank pressures</strong>: single starting LOX and fuel tank pressures (no time history)</li>
        </ul>
        <p className="text-sm text-[var(--color-text-secondary)] mt-2">
          This layer evaluates at t=0 (static) to find an engine geometry and initial tank pressures that meet the target thrust/O/F and stability requirements. All time‑varying pressure curves and thermal protection sizing are handled in downstream layers (Layer 2/3).
        </p>
      </div>


      {/* Settings */}
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
        <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4">⚙️ Optimization Settings</h3>
        <div className="grid grid-cols-1 gap-4">
          <div>
            <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Thrust Tolerance [%]
            </label>
            <input
              type="number"
              value={settings.thrust_tolerance * 100}
              onChange={(e) => setSettings(prev => ({ ...prev, thrust_tolerance: parseFloat(e.target.value) / 100 }))}
              className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
              min="1"
              max="20"
              step="1"
              disabled={isRunning}
            />
            <p className="text-xs text-[var(--color-text-secondary)] mt-1">Acceptable deviation from target thrust</p>
          </div>
        </div>
      </div>

      {/* Run/Stop Button */}
      <div className="flex flex-wrap justify-center items-center gap-4">
        {isDirty && (
          <span className="text-xs px-3 py-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-300">
            Unsaved Design Requirements — will auto-save on Run
          </span>
        )}
        <button
          onClick={handleRun}
          disabled={isRunning}
          className={`px-8 py-4 font-bold rounded-lg text-white text-lg transition-all ${isRunning
            ? 'bg-gray-500 cursor-not-allowed'
            : 'bg-blue-600 hover:bg-blue-700 hover:scale-105'
            }`}
        >
          {isRunning ? '🔄 Running Optimization...' : '🚀 Run Layer 1 Optimization'}
        </button>
        {isRunning && (
          <button
            onClick={handleStop}
            className="px-8 py-4 font-bold rounded-lg text-white text-lg transition-all bg-red-600 hover:bg-red-700 hover:scale-105"
          >
            ⏹ Stop Optimizer
          </button>
        )}
      </div>

      {/* Progress */}
      {(isRunning || progress > 0) && (
        <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
          <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4">📊 Progress</h3>

          {/* Progress Bar */}
          <div className="mb-4">
            <div className="flex justify-between text-sm text-[var(--color-text-secondary)] mb-2">
              <span>{stage}</span>
              <span>{(progress * 100).toFixed(0)}%</span>
            </div>
            <div className="w-full bg-[var(--color-bg-primary)] rounded-full h-4 overflow-hidden border border-[var(--color-border)]">
              <div
                className="bg-blue-600 h-full rounded-full transition-all duration-300"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
            <p className="text-sm text-[var(--color-text-secondary)] mt-2">{message}</p>
          </div>

          {/* Objective Convergence Plot - Always visible during optimization */}
          <div className="mt-6">
            <h4 className="text-md font-semibold text-[var(--color-text-primary)] mb-2">
              Objective Convergence
              {objectiveHistory.length > 0 && (
                <span className="text-sm font-normal text-[var(--color-text-secondary)] ml-2">
                  ({objectiveHistory.length} iterations)
                </span>
              )}
            </h4>
            {objectiveHistory.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={objectiveHistory} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
                  <XAxis
                    dataKey="iteration"
                    stroke="var(--color-text-secondary)"
                    tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                    label={{ value: 'Iteration', position: 'insideBottom', offset: -5, fill: 'var(--color-text-secondary)' }}
                  />
                  <YAxis
                    scale="log"
                    domain={['auto', 'auto']}
                    stroke="var(--color-text-secondary)"
                    tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                    label={{ value: 'Objective Value (log)', angle: -90, position: 'insideLeft', fill: 'var(--color-text-secondary)' }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--color-bg-secondary)',
                      border: '1px solid var(--color-border)',
                      borderRadius: '0.5rem',
                      color: 'var(--color-text-primary)'
                    }}
                  />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="objective"
                    name="Objective"
                    stroke="#3b82f6"
                    strokeWidth={0}
                    dot={renderDot}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="best_objective"
                    name="Best Objective"
                    stroke="#f97316"
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-64 bg-[var(--color-bg-primary)] rounded-lg border border-[var(--color-border)]">
                <p className="text-[var(--color-text-secondary)]">
                  Waiting for objective function data...
                </p>
              </div>
            )}

            {/* Button to show parameter plots */}
            {results?.iteration_history && results.iteration_history.length > 0 && (
              <div className="mt-4 flex justify-center">
                <button
                  onClick={() => setShowParameterPlots(!showParameterPlots)}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors text-sm font-medium"
                >
                  {showParameterPlots ? '▼ Hide Parameter Plots' : '▶ Show Parameter Convergence Plots'}
                </button>
              </div>
            )}
          </div>

          {/* Parameter Convergence Plots */}
          {showParameterPlots && results?.iteration_history && results.iteration_history.length > 0 && (
            <div className="mt-6 border-t border-[var(--color-border)] pt-6">
              <h4 className="text-md font-semibold text-[var(--color-text-primary)] mb-4">
                Parameter Convergence History
              </h4>
              <ParameterConvergencePlots iterationHistory={results.iteration_history} geometry={results.geometry} />
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
          <p className="text-red-400 font-semibold">❌ Error: {error}</p>
        </div>
      )}

      {/* Results */}
      {results && results.performance && (
        <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-semibold text-[var(--color-text-primary)]">✅ Optimization Results</h3>
            {results.config_yaml && (
              <button
                onClick={() => {
                  const blob = new Blob([results.config_yaml!], { type: 'text/yaml' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'layer1_optimized_config.yaml';
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                }}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors text-sm font-medium shadow-sm"
              >
                <span>💾 Download Optimized Config (YAML)</span>
              </button>
            )}
          </div>

          {/* Key Performance Metrics */}
          <div className="mb-6">
            <h4 className="text-md font-semibold text-[var(--color-text-primary)] mb-3">🎯 Performance</h4>
            <div className="grid grid-cols-4 gap-4">
              <ResultCard
                label="Thrust"
                value={results.performance.F}
                unit="N"
                decimals={1}
                color="blue"
              />
              <ResultCard
                label="O/F Ratio"
                value={results.performance.MR}
                decimals={2}
                color="yellow"
              />
              <ResultCard
                label="Specific Impulse"
                value={results.performance.Isp}
                unit="s"
                decimals={1}
                color="purple"
              />
              <ResultCard
                label="Chamber Pressure"
                value={results.performance.Pc ? (results.performance.Pc as number) / 6894.76 : undefined}
                unit="psi"
                decimals={1}
                color="green"
              />
              {/* Exit Pressure with target display */}
              <div className="rounded-lg p-3 border bg-cyan-500/10 border-cyan-500/30">
                <p className="text-xs text-[var(--color-text-secondary)] mb-1">Exit Pressure</p>
                <p className="text-lg font-bold text-cyan-400">
                  {results.performance.P_exit
                    ? ((results.performance.P_exit as number) / 6894.76).toFixed(1)
                    : '-'}
                  <span className="text-sm font-normal text-[var(--color-text-secondary)] ml-1">psi</span>
                  {results.performance.target_P_exit !== undefined && results.performance.target_P_exit !== null && (
                    <span className="text-xs font-normal text-[var(--color-text-secondary)] ml-1">
                      (Target: {((results.performance.target_P_exit as number) / 6894.76).toFixed(1)} psi)
                    </span>
                  )}
                </p>
              </div>
              <ResultCard
                label="Thrust Coefficient"
                value={results.performance.Cf || results.performance.Cf_actual}
                decimals={2}
                color="orange"
              />
              <ResultCard
                label="Combustion efficiency η_c* (c* actual / c* ideal)"
                value={results.performance.eta_cstar ? (results.performance.eta_cstar as number) * 100 : undefined}
                unit="%"
                decimals={1}
                color="pink"
              />
              <ResultCard
                label="Total Mass Flow"
                value={results.performance.mdot_total}
                unit="kg/s"
                decimals={3}
                color="indigo"
              />
              <ResultCard
                label="Choked Flow Verified?"
                value={results.performance.chamber_intrinsics?.is_choked === true ? 'Yes' : results.performance.chamber_intrinsics?.is_choked === false ? 'No' : '—'}
                isText={true}
                color={results.performance.chamber_intrinsics?.is_choked === true ? 'green' : results.performance.chamber_intrinsics?.is_choked === false ? 'red' : 'blue'}
              />
              <ResultCard
                label="Effective Injector Area / Throat Area"
                value={results.performance.effective_injector_area_ratio}
                decimals={3}
                color={
                  results.performance.effective_injector_area_ratio !== undefined
                    ? (results.performance.effective_injector_area_ratio >= 0.25 && results.performance.effective_injector_area_ratio <= 0.6)
                      ? 'green'
                      : results.performance.effective_injector_area_ratio < 0.25
                        ? 'yellow'
                        : 'red'
                    : 'blue'
                }
              />
              <ResultCard
                label="Effective SMD (mass-flux weighted streams)"
                value={results.performance.effective_smd_microns as number | undefined}
                unit="um"
                decimals={1}
                color="cyan"
              />
              <ResultCard
                label="Impingement Angle (effective)"
                value={results.performance.impingement_angle_deg_effective as number | undefined}
                unit="deg"
                decimals={1}
                color="indigo"
              />
              {(() => {
                const perf = results.performance as Record<string, unknown>;
                const lo = perf.layer1_Lstar_search_min_m;
                const hi = perf.layer1_Lstar_search_max_m;
                if (typeof lo !== 'number' || typeof hi !== 'number' || !Number.isFinite(lo) || !Number.isFinite(hi)) {
                  return null;
                }
                return (
                  <ResultCard
                    label="L* search band (Layer 1, used by solver)"
                    value={`${lo.toFixed(3)}–${hi.toFixed(3)} m`}
                    isText
                    color="blue"
                  />
                );
              })()}
              <ResultCard
                label="Chamber Ac / throat At (η model)"
                value={(() => {
                  const v = (results.performance as Record<string, unknown>).layer1_geometry_Ac_over_At;
                  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
                })()}
                decimals={2}
                color="blue"
              />
              <ResultCard
                label="Vch / At vs config L*"
                value={(() => {
                  const perf = results.performance as Record<string, unknown>;
                  const ok = perf.layer1_geometry_V_equals_Lstar_At;
                  if (ok === true) return 'Consistent';
                  if (ok === false) return 'Check logs';
                  return undefined;
                })()}
                isText
                color={
                  (results.performance as Record<string, unknown>).layer1_geometry_V_equals_Lstar_At === true
                    ? 'green'
                    : (results.performance as Record<string, unknown>).layer1_geometry_V_equals_Lstar_At === false
                      ? 'yellow'
                      : 'blue'
                }
              />
            </div>
          </div>

          {(() => {
            const usedRaw = (results.performance as Record<string, unknown>).layer1_requirements_used;
            if (!usedRaw || typeof usedRaw !== 'object') return null;
            const used = usedRaw as Record<string, unknown>;
            const keys = Object.keys(used).sort((a, b) => a.localeCompare(b));
            const formObj = requirements as unknown as Record<string, unknown>;
            return (
              <details
                open={showSolverInputsEcho}
                onToggle={(e) => setShowSolverInputsEcho((e.target as HTMLDetailsElement).open)}
                className="mb-6 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-4"
              >
                <summary className="cursor-pointer text-md font-semibold text-[var(--color-text-primary)]">
                  Inputs the solver actually used (full audit)
                </summary>
                <p className="text-xs text-[var(--color-text-secondary)] mt-2 mb-3">
                  Compares each key to your current Design Requirements form. After a run, values should match if you did not edit the form since running.
                </p>
                <div className="overflow-x-auto max-h-96 overflow-y-auto border border-[var(--color-border)] rounded-lg">
                  <table className="min-w-full text-sm">
                    <thead className="sticky top-0 bg-[var(--color-bg-primary)]">
                      <tr className="text-left border-b border-[var(--color-border)]">
                        <th className="p-2 font-medium text-[var(--color-text-secondary)]">Key</th>
                        <th className="p-2 font-medium text-[var(--color-text-secondary)]">Value used</th>
                        <th className="p-2 font-medium text-[var(--color-text-secondary)]">Matches form?</th>
                      </tr>
                    </thead>
                    <tbody>
                      {keys.map((key) => {
                        const vUsed = used[key];
                        const vForm = formObj[key];
                        const usedS = stableStringify(vUsed);
                        const formS = stableStringify(vForm);
                        const match = usedS === formS;
                        const derivedKeys = new Set([
                          'report_every_n',
                          'W_geom_ao_af_momentum',
                        ]);
                        const isDerived = derivedKeys.has(key) && !match;
                        return (
                          <tr key={key} className="border-b border-[var(--color-border)]/60">
                            <td className="p-2 font-mono text-xs text-[var(--color-text-primary)] align-top">{key}</td>
                            <td className="p-2 font-mono text-xs text-blue-300 align-top break-all max-w-md">
                              {typeof vUsed === 'object' && vUsed !== null
                                ? JSON.stringify(vUsed)
                                : String(vUsed)}
                            </td>
                            <td className="p-2 align-top whitespace-nowrap">
                              {match ? (
                                <span className="text-green-400">Yes</span>
                              ) : isDerived ? (
                                <span
                                  className="text-blue-300"
                                  title={
                                    key === 'report_every_n'
                                      ? 'Internal optimizer reporting cadence (backend default). Not a design requirement mismatch.'
                                      : 'Effective derived guidance value used by solver for this run.'
                                  }
                                >
                                  Derived (hover)
                                </span>
                              ) : (
                                <span className="text-amber-400" title={`Form: ${JSON.stringify(vForm)}`}>
                                  No (hover)
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </details>
            );
          })()}

          {/* Objective Diagnostics */}
          {results.convergence_info?.best_objective !== undefined && (
            <div className="mb-6">
              <h4 className="text-md font-semibold text-[var(--color-text-primary)] mb-3">🧠 Objective Diagnostics</h4>
              <div className="grid grid-cols-2 gap-4 mb-3">
                <ResultCard
                  label="Best Objective (Residual)"
                  value={(() => {
                    const v = results.convergence_info.best_objective;
                    return typeof v === 'number' && Number.isFinite(v) ? formatLayer1ResidualScalar(v) : '-';
                  })()}
                  isText
                  color={
                    (results.convergence_info.best_objective ?? 0) <= 1
                      ? 'green'
                      : (results.convergence_info.best_objective ?? 0) <= 10
                        ? 'yellow'
                        : 'red'
                  }
                  footnote={(() => {
                    const v = results.convergence_info.best_objective;
                    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
                      return 'Weighted sum of squared penalties (W≈1e2–1e4); not comparable to 1e-14 machine epsilon.';
                    }
                    return `Weighted scalar (same as log plot): log10 ≈ ${Math.log10(v).toFixed(3)}. Compare physics RMS below.`;
                  })()}
                />
                <ResultCard
                  label="Converged?"
                  value={results.convergence_info.converged ? 'Yes' : 'No'}
                  isText
                  color={results.convergence_info.converged ? 'green' : 'yellow'}
                />
              </div>
              {results.convergence_info.primary_relative_residual &&
                typeof results.convergence_info.primary_relative_residual.rms_primary === 'number' &&
                Number.isFinite(results.convergence_info.primary_relative_residual.rms_primary) && (
                  <div className="mb-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-3">
                    <p className="mb-2 text-xs text-[var(--color-text-secondary)] leading-relaxed">
                      Primary relative convergence (dimensionless): thrust, O/F, and exit-pressure fractional error.
                      This is the meaningful “how tight is the match?” metric — not the weighted optimizer scalar above.
                    </p>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                      <div className="flex justify-between gap-2">
                        <span className="text-[var(--color-text-secondary)]">|ΔF|/F</span>
                        <span className="font-mono text-emerald-400">
                          {(() => {
                            const x = results.convergence_info.primary_relative_residual?.rel_thrust;
                            return typeof x === 'number' && Number.isFinite(x)
                              ? formatLayer1ResidualScalar(x)
                              : '—';
                          })()}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span className="text-[var(--color-text-secondary)]">|ΔMR|/MR</span>
                        <span className="font-mono text-emerald-400">
                          {(() => {
                            const x = results.convergence_info.primary_relative_residual?.rel_of;
                            return typeof x === 'number' && Number.isFinite(x)
                              ? formatLayer1ResidualScalar(x)
                              : '—';
                          })()}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span className="text-[var(--color-text-secondary)]">|ΔP_exit|/P</span>
                        <span className="font-mono text-emerald-400">
                          {(() => {
                            const x = results.convergence_info.primary_relative_residual?.rel_P_exit;
                            return typeof x === 'number' && Number.isFinite(x)
                              ? formatLayer1ResidualScalar(x)
                              : '—';
                          })()}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2 border-t border-[var(--color-border)] pt-2 md:border-t-0 md:pt-0 md:border-l md:pl-2">
                        <span className="text-[var(--color-text-secondary)]">RMS (3-way)</span>
                        <span className="font-mono font-semibold text-[var(--color-text-primary)]">
                          {formatLayer1ResidualScalar(
                            results.convergence_info.primary_relative_residual.rms_primary
                          )}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              {results.convergence_info.best_objective_breakdown &&
                Object.keys(results.convergence_info.best_objective_breakdown).length > 0 && (
                  <div className="bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg p-3">
                    <p className="text-xs text-[var(--color-text-secondary)] mb-2">
                      Largest objective contributors
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      {Object.entries(results.convergence_info.best_objective_breakdown)
                        .filter(([key, value]) =>
                          typeof value === 'number' &&
                          Number.isFinite(value) &&
                          (key.endsWith('_penalty') || key === 'infeasibility_penalty')
                        )
                        .sort((a, b) => Number(b[1]) - Number(a[1]))
                        .slice(0, 6)
                        .map(([key, value]) => (
                          <div key={key} className="flex justify-between text-sm">
                            <span className="text-[var(--color-text-secondary)]">{key}</span>
                            <span className="font-mono text-blue-400">{formatLayer1ResidualScalar(Number(value))}</span>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
            </div>
          )}

          {/* Optimized Pressures */}
          <div className="mb-6">
            <h4 className="text-md font-semibold text-[var(--color-text-primary)] mb-3">🔋 Optimized Tank Pressures</h4>
            <div className="grid grid-cols-2 gap-4">
              <ResultCard
                label="LOX Tank Pressure"
                value={results.performance.P_O_start_psi}
                unit="psi"
                decimals={1}
                color="cyan"
              />
              <ResultCard
                label="Fuel Tank Pressure"
                value={results.performance.P_F_start_psi}
                unit="psi"
                decimals={1}
                color="orange"
              />
            </div>
            {(() => {
              const perf = results.performance as Record<string, unknown>;
              const sc = perf.layer1_validation_tank_pressure_scale;
              const scale = typeof sc === 'number' && Number.isFinite(sc) ? sc : undefined;
              const boosted =
                perf.layer1_validation_replay_boosted_tanks === true
                || (scale !== undefined && scale > 1.01);
              if (!boosted) return null;
              const prO = perf.P_O_start_psi_validation_replay;
              const prF = perf.P_F_start_psi_validation_replay;
              const replayPsi =
                typeof prO === 'number' && Number.isFinite(prO) && typeof prF === 'number' && Number.isFinite(prF)
                  ? `LOX ${prO.toFixed(1)} psi, fuel ${prF.toFixed(1)} psi`
                  : undefined;
              return (
                <p className="mt-2 text-xs text-[var(--color-text-secondary)] leading-relaxed">
                  Validation replay scaled nominal tank stagnation pressures by{' '}
                  <span className="font-medium text-[var(--color-text-primary)]">
                    {scale !== undefined ? `×${scale.toFixed(3)}` : 'a boost factor'}
                  </span>{' '}
                  so <code className="text-[11px]">evaluate()</code> could close (supply-limited at nominal).{' '}
                  Thrust, Pc, and injector diagnostics below correspond to that replay
                  {replayPsi ? ` (${replayPsi})` : ''}. Downloaded YAML uses nominal tank pressures above.
                </p>
              );
            })()}
          </div>

          {/* Injector / Post-Injector Pressure Details */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-md font-semibold text-[var(--color-text-primary)]">🫧 Injector Pressure Drops</h4>
              <button
                onClick={() => setShowInjectorPressures((v) => !v)}
                className="px-3 py-1.5 text-xs rounded-md border border-[var(--color-border)] hover:bg-[var(--color-bg-primary)] transition-colors"
              >
                {showInjectorPressures ? 'Hide Details' : 'Show Details'}
              </button>
            </div>
            {showInjectorPressures && (() => {
              const ip = (results.performance.injector_pressure as Record<string, unknown> | undefined) ?? {};
              const paToPsi = 1 / 6894.76;
              const asPsi = (v: unknown): number | undefined =>
                (typeof v === 'number' && Number.isFinite(v)) ? v * paToPsi : undefined;
              return (
                <div className="grid grid-cols-3 gap-4">
                  <ResultCard label="P_injector LOX" value={asPsi(ip.P_injector_O)} unit="psi" decimals={1} color="cyan" />
                  <ResultCard label="P_injector Fuel" value={asPsi(ip.P_injector_F)} unit="psi" decimals={1} color="orange" />
                  <ResultCard label="Post-Inj (Pc)" value={results.performance.Pc ? (results.performance.Pc as number) / 6894.76 : undefined} unit="psi" decimals={1} color="green" />
                  <ResultCard label="ΔP Injector LOX" value={asPsi(ip.delta_p_injector_O)} unit="psi" decimals={1} color="cyan" />
                  <ResultCard label="ΔP Injector Fuel" value={asPsi(ip.delta_p_injector_F)} unit="psi" decimals={1} color="orange" />
                  <ResultCard label="ΔP Feed Total" value={(() => {
                    const dpo = asPsi(ip.delta_p_feed_O);
                    const dpf = asPsi(ip.delta_p_feed_F);
                    return dpo !== undefined && dpf !== undefined ? dpo + dpf : undefined;
                  })()} unit="psi" decimals={1} color="purple" />
                </div>
              );
            })()}
          </div>

          {/* Stability Results */}
          <div className="mb-6">
            <h4 className="text-md font-semibold text-[var(--color-text-primary)] mb-3">🛡️ Stability Analysis</h4>
            {(() => {
              // Extract stability data from various possible locations
              const perf = results.performance;
              const stabResults = perf.stability_results as Record<string, unknown> | undefined;

              // Get stability score and state (might be at root or nested)
              const stabilityScore = (perf.initial_stability_score as number) ??
                (stabResults?.stability_score as number) ?? undefined;
              const stabilityState = (perf.initial_stability_state as string) ??
                (stabResults?.stability_state as string) ?? 'unknown';

              // Get margins - could be at root level OR nested in stability_results
              const chuggingMargin = (perf.chugging_margin as number) ??
                ((stabResults?.chugging as Record<string, unknown>)?.stability_margin as number) ?? undefined;
              const acousticMargin = (perf.acoustic_margin as number) ??
                ((stabResults?.acoustic as Record<string, unknown>)?.stability_margin as number) ?? undefined;
              const feedMargin = (perf.feed_margin as number) ??
                ((stabResults?.feed_system as Record<string, unknown>)?.stability_margin as number) ?? undefined;

              return (
                <div className="grid grid-cols-5 gap-4">
                  <ResultCard
                    label="Stability Score"
                    value={stabilityScore}
                    decimals={2}
                    color={stabilityScore !== undefined && stabilityScore >= 0.75 ? 'green' :
                      stabilityScore !== undefined && stabilityScore >= 0.4 ? 'yellow' : 'red'}
                  />
                  <ResultCard
                    label="Stability State"
                    value={stabilityState}
                    isText
                    color={stabilityState === 'stable' ? 'green' :
                      stabilityState === 'marginal' ? 'yellow' : 'red'}
                  />
                  <ResultCard
                    label="Chugging Margin"
                    value={chuggingMargin}
                    decimals={3}
                    color="purple"
                  />
                  <ResultCard
                    label="Acoustic Margin"
                    value={acousticMargin}
                    decimals={3}
                    color="blue"
                  />
                  <ResultCard
                    label="Feed System Margin"
                    value={feedMargin}
                    decimals={3}
                    color="cyan"
                  />
                </div>
              );
            })()}
          </div>

          {/* Optimized Geometry */}
          {results.geometry && Object.keys(results.geometry).length > 0 && (
            <div className="mb-6">
              <h4 className="text-md font-semibold text-[var(--color-text-primary)] mb-3">
                📐 Optimized Geometry
                {typeof results.geometry.injector_type === 'string' && (
                  <span className="ml-2 text-xs px-2 py-1 rounded bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
                    injector: {String(results.geometry.injector_type)}
                  </span>
                )}
              </h4>
              <GeometryTable geometry={results.geometry} />
            </div>
          )}

          {/* Validation Status */}
          <div className="mb-6">
            <h4 className="text-md font-semibold text-[var(--color-text-primary)] mb-3">✓ Validation</h4>
            {(() => {
              const injType = String(
                results.geometry?.injector_type ??
                  (results.config?.injector as Record<string, unknown> | undefined)?.type ??
                  ''
              ).toLowerCase();
              const isImpingingResults = injType === 'impinging';
              return (
                <div
                  className={`grid gap-4 ${
                    isImpingingResults
                      ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-6'
                      : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5'
                  }`}
                >
                  <ValidationCard
                    label="Thrust Check"
                    passed={results.performance.thrust_check_passed}
                  />
                  <ValidationCard
                    label="O/F Check"
                    passed={results.performance.of_check_passed}
                  />
                  <ValidationCard
                    label="Stability Check"
                    passed={results.performance.stability_check_passed}
                  />
                  <ValidationCard
                    label="Geometry Check"
                    passed={results.performance.geometry_check_passed}
                  />
                  {isImpingingResults && (
                    <ValidationCard
                      label="Momentum Check"
                      passed={results.performance.momentum_gate_passed}
                    />
                  )}
                  <ValidationCard
                    label="Pressure Candidate"
                    passed={results.performance.pressure_candidate_valid}
                  />
                </div>
              );
            })()}
            {(() => {
              const injType = String(
                results.geometry?.injector_type ??
                  (results.config?.injector as Record<string, unknown> | undefined)?.type ??
                  ''
              ).toLowerCase();
              const isImpingingResults = injType === 'impinging';
              const oRatio = typeof results.performance.injector_dp_ratio_O === 'number'
                ? results.performance.injector_dp_ratio_O as number
                : undefined;
              const fRatio = typeof results.performance.injector_dp_ratio_F === 'number'
                ? results.performance.injector_dp_ratio_F as number
                : undefined;
              const oMin = requirements?.injector_dp_ratio_O_min;
              const oMax = requirements?.injector_dp_ratio_O_max;
              const fMin = requirements?.injector_dp_ratio_F_min;
              const fMax = requirements?.injector_dp_ratio_F_max;
              const hasBands = [oMin, oMax, fMin, fMax].every((v) => typeof v === 'number');
              const perf = results.performance;
              const rVal =
                typeof perf.momentum_ratio_R === 'number' && Number.isFinite(perf.momentum_ratio_R)
                  ? perf.momentum_ratio_R
                  : undefined;
              const rMin = requirements?.impinging_momentum_R_min;
              const rMax = requirements?.impinging_momentum_R_max;
              const rBandOk =
                typeof rMin === 'number' &&
                typeof rMax === 'number' &&
                rVal !== undefined &&
                rVal >= rMin &&
                rVal <= rMax;
              const rPass =
                typeof perf.momentum_gate_passed === 'boolean'
                  ? perf.momentum_gate_passed
                  : rBandOk;
              const hasRBands = typeof rMin === 'number' && typeof rMax === 'number';
              if (!hasBands && !isImpingingResults) return null;
              if (isImpingingResults && !hasBands && !hasRBands && rVal === undefined) return null;
              const oPass = oRatio !== undefined ? (oRatio >= (oMin as number) && oRatio <= (oMax as number)) : undefined;
              const fPass = fRatio !== undefined ? (fRatio >= (fMin as number) && fRatio <= (fMax as number)) : undefined;
              const gridCols = !isImpingingResults
                ? 'grid-cols-1 md:grid-cols-2'
                : hasBands
                  ? 'grid-cols-1 md:grid-cols-3'
                  : 'grid-cols-1';
              return (
                <div className={`mt-3 grid gap-4 ${gridCols}`}>
                  {hasBands && (
                    <>
                      <div className={`p-3 rounded-lg border ${oPass === true ? 'bg-green-500/10 border-green-500/30' : 'bg-amber-500/10 border-amber-500/30'}`}>
                        <p className="text-xs text-[var(--color-text-secondary)] mb-1">
                          ΔP_O/Pc band [{(oMin as number).toFixed(3)}, {(oMax as number).toFixed(3)}]
                        </p>
                        <p className="font-mono text-sm">
                          actual: {oRatio !== undefined ? oRatio.toFixed(3) : '—'} {oPass === true ? '✓' : oPass === false ? '✗' : ''}
                        </p>
                      </div>
                      <div className={`p-3 rounded-lg border ${fPass === true ? 'bg-green-500/10 border-green-500/30' : 'bg-amber-500/10 border-amber-500/30'}`}>
                        <p className="text-xs text-[var(--color-text-secondary)] mb-1">
                          ΔP_F/Pc band [{(fMin as number).toFixed(3)}, {(fMax as number).toFixed(3)}]
                        </p>
                        <p className="font-mono text-sm">
                          actual: {fRatio !== undefined ? fRatio.toFixed(3) : '—'} {fPass === true ? '✓' : fPass === false ? '✗' : ''}
                        </p>
                      </div>
                    </>
                  )}
                  {isImpingingResults && (
                    <div
                      className={`p-3 rounded-lg border ${
                        rPass === true
                          ? 'bg-green-500/10 border-green-500/30'
                          : 'bg-amber-500/10 border-amber-500/30'
                      }`}
                    >
                      <p className="text-xs text-[var(--color-text-secondary)] mb-1">
                        Momentum ratio R
                        {hasRBands ? ` [${(rMin as number).toFixed(3)}, ${(rMax as number).toFixed(3)}]` : ''} · target ~1.000
                      </p>
                      <p className="font-mono text-sm">
                        actual: {rVal !== undefined ? rVal.toFixed(3) : '—'}{' '}
                        {rPass === true ? '✓' : rPass === false ? '✗' : ''}
                      </p>
                      <button
                        type="button"
                        className="mt-2 text-xs text-[var(--color-text-secondary)] underline hover:text-[var(--color-text-primary)]"
                        onClick={() => setMomentumRAuditOpen((o) => !o)}
                      >
                        {momentumRAuditOpen ? 'Hide' : 'Show'} R calculation inputs
                      </button>
                      {momentumRAuditOpen && (
                        <dl className="mt-2 space-y-1 text-xs font-mono text-[var(--color-text-secondary)] border-t border-[var(--color-border)] pt-2">
                          <div className="flex justify-between gap-2">
                            <dt>ρ_O (momentum)</dt>
                            <dd>
                              {typeof perf.rho_O_momentum === 'number'
                                ? perf.rho_O_momentum.toFixed(3)
                                : '—'}{' '}
                              kg/m³
                            </dd>
                          </div>
                          <div className="flex justify-between gap-2">
                            <dt>ρ_F (momentum)</dt>
                            <dd>
                              {typeof perf.rho_F_momentum === 'number'
                                ? perf.rho_F_momentum.toFixed(3)
                                : '—'}{' '}
                              kg/m³
                            </dd>
                          </div>
                          <div className="flex justify-between gap-2">
                            <dt>v_O_bulk</dt>
                            <dd>
                              {typeof perf.v_O_bulk === 'number' ? perf.v_O_bulk.toFixed(4) : '—'} m/s
                            </dd>
                          </div>
                          <div className="flex justify-between gap-2">
                            <dt>v_F_bulk</dt>
                            <dd>
                              {typeof perf.v_F_bulk === 'number' ? perf.v_F_bulk.toFixed(4) : '—'} m/s
                            </dd>
                          </div>
                          <div className="flex justify-between gap-2">
                            <dt>n_elements O / F</dt>
                            <dd>
                              {typeof perf.momentum_ratio_n_elements_O === 'number'
                                ? perf.momentum_ratio_n_elements_O
                                : '—'}{' '}
                              /{' '}
                              {typeof perf.momentum_ratio_n_elements_F === 'number'
                                ? perf.momentum_ratio_n_elements_F
                                : '—'}
                            </dd>
                          </div>
                          <div className="flex justify-between gap-2">
                            <dt>d_jet O / F</dt>
                            <dd>
                              {typeof perf.d_jet_O === 'number'
                                ? (perf.d_jet_O * 1000).toFixed(4)
                                : '—'}{' '}
                              /{' '}
                              {typeof perf.d_jet_F === 'number'
                                ? (perf.d_jet_F * 1000).toFixed(4)
                                : '—'}{' '}
                              mm
                            </dd>
                          </div>
                          <div className="flex justify-between gap-2">
                            <dt>A_jet O / F</dt>
                            <dd>
                              {typeof perf.A_jet_O === 'number'
                                ? (perf.A_jet_O * 1e6).toFixed(6)
                                : '—'}{' '}
                              /{' '}
                              {typeof perf.A_jet_F === 'number'
                                ? (perf.A_jet_F * 1e6).toFixed(6)
                                : '—'}{' '}
                              mm²
                            </dd>
                          </div>
                          <div className="pt-1 text-[var(--color-text-secondary)]">
                            R = √(ρ_O·v_O²/(ρ_F·v_F²)) using bulk jets per stream (mdot/(ρ·n·A_jet)).
                          </div>
                        </dl>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}
            {results.performance.failure_reasons && results.performance.failure_reasons.length > 0 && (
              <div className="mt-3 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                <p className="text-sm text-red-400 font-semibold mb-1">Failure Reasons:</p>
                <ul className="text-sm text-red-400 list-disc list-inside">
                  {results.performance.failure_reasons.map((reason: string, i: number) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Chamber Contour Plot */}
          {chamberGeometry && chamberGeometry.chamber_contour_x && chamberGeometry.chamber_contour_x.length > 0 && (
            <div className="mt-6">
              <h4 className="text-md font-semibold text-[var(--color-text-primary)] mb-3">📊 Optimized Chamber Contour</h4>
              <ChamberContourPlot
                geometry={chamberGeometry}
                title="Optimized Chamber Geometry"
                showCfBadge={true}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

