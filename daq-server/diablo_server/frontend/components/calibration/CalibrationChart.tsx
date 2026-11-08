'use client'

import { useMemo } from 'react';
import {
  ComposedChart, Scatter, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Label,
} from 'recharts';
import { CubicCalibrationChannel } from '@/lib/types';

// The service supplies captured points, the linear and cubic fits (`fits`, with the active one also
// as `polyCoeffs`), and a pre-sampled robust `fitCurve`.
// Physics is a closed form the browser evaluates directly. The browser never fits — it only draws
// the captured points plus each model's curve so you can compare them before choosing a model.

const ADC_MAX = 2147483648; // 2^31 — matches the service's ratiometric/4-20mA conversion scale.

export interface PhysicsParams {
  fullScale: number;        // PSI at full scale
  isLoop: boolean;          // true = 4-20 mA current loop, false = 0-5 V ratiometric
  senseResistor?: number;   // Ω (loop only)
  adcRefVoltage?: number;   // ADC reference volts (loop only; default 2.5)
}

/** LC datasheet physics params — mirrors convert_lc_adc_to_force in calibration_main.cpp. */
export interface LcPhysicsParams {
  fullScale: number;        // kg at full scale
  sensitivityMvPerV: number;
  pgaGain: number;
}

// Datasheet conversion — mirrors convert_ratiometric_pt_to_pressure / convert_hp_pt_to_pressure.
function physicsPsi(adc: number, p: PhysicsParams): number {
  const frac = adc / ADC_MAX;
  if (p.isLoop) {
    const vSense = frac * (p.adcRefVoltage ?? 2.5);
    const iMa = (vSense / (p.senseResistor ?? 120)) * 1000;
    return ((iMa - 4) / 16) * p.fullScale;
  }
  return frac * p.fullScale;
}

// LC datasheet conversion — mirrors convert_lc_adc_to_force: excitation is the ADC reference, so it
// cancels; code_fs = (sensitivity_mV/V / 1000) * PGA_gain * ADC_MAX.
function physicsKg(adc: number, p: LcPhysicsParams): number {
  const codeFs = (p.sensitivityMvPerV / 1000) * p.pgaGain * ADC_MAX;
  if (!(codeFs > 0)) return 0;
  return (adc / codeFs) * p.fullScale;
}

/**
 * The ADC code at this sensor's full scale — where its physics curve actually ends.
 *
 * Fixed by the datasheet params in config, so it is identical for two identically
 * configured channels no matter what either of them has captured.
 */
function physicsSpanAdc(physics?: PhysicsParams, lcPhysics?: LcPhysicsParams): number {
  if (lcPhysics) {
    const codeFs = (lcPhysics.sensitivityMvPerV / 1000) * lcPhysics.pgaGain * ADC_MAX;
    return codeFs > 0 ? codeFs : ADC_MAX;
  }
  if (physics?.isLoop) {
    // Full scale is 20 mA through the sense resistor.
    const vSense = (20 / 1000) * (physics.senseResistor ?? 120);
    const frac = vSense / (physics.adcRefVoltage ?? 2.5);
    return frac > 0 ? frac * ADC_MAX : ADC_MAX;
  }
  // 0-5 V ratiometric reaches full scale at full code.
  return ADC_MAX;
}

/**
 * The [lo, hi] ADC range the model curves are swept across.
 *
 * A cubic is only meaningful near the points it was fitted to, so a cubic/robust sensor
 * zooms to its captures. Physics is not: it is a fixed datasheet formula that reads
 * nothing from the capture history. Sweeping it over a capture window made two
 * identically configured load cells draw completely different-looking curves — the same
 * line, on axes a hundredfold apart (stand, 2026-09-13). A physics sensor therefore gets
 * its own full-scale range, identical for every channel configured the same way, and its
 * captured points still plot at their true position on it.
 *
 * Exported for the test; the component is the only caller.
 */
export type ChartModel = 'cubic' | 'robust' | 'physics' | 'linear';

export function physicsSweepRangeForTests(
  activeModel: ChartModel | undefined,
  points: Array<{ adc: number }>,
  physics?: PhysicsParams,
  lcPhysics?: LcPhysicsParams,
): [number, number] {
  // No captures also lands here: the old code then swept to ADC_MAX, which for a 2 mV/V
  // load cell at PGA 32 is 15x past anything the sensor can output.
  if (activeModel === 'physics' || points.length === 0) {
    return [0, physicsSpanAdc(physics, lcPhysics)];
  }
  const adcs = points.map((p) => p.adc);
  let lo = Math.min(...adcs);
  let hi = Math.max(...adcs);
  const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.1 || 1;
  lo -= pad;
  hi += pad;
  return [lo, hi];
}

function evalCubicNorm(adc: number, poly: number[], min: number, scale: number): number {
  const s = scale || 1;
  const x = (adc - min) / s;
  let xp = 1;
  let y = 0;
  for (let i = 0; i < poly.length; i++) { y += poly[i] * xp; xp *= x; }
  return y;
}

interface Row { adc: number; psi?: number; op?: number; psiCubic?: number; psiLinear?: number; psiRobust?: number; psiPhysics?: number }

type FitForm = { poly: number[]; min: number; scale: number };

/**
 * The cubic and linear curves to draw, from the service's two fits. A file written before linear
 * existed carries only the active fit (`polyCoeffs`), which was then always the cubic.
 * Exported for the test; the component is the only caller.
 */
export function fitCurvesForTests(state?: CubicCalibrationChannel): { cubic?: FitForm; linear?: FitForm } {
  if (!state) return {};
  const form = (f?: { valid?: boolean; polyCoeffs?: number[]; adcNormMin?: number; adcNormScale?: number }) =>
    f && f.valid && f.polyCoeffs && f.polyCoeffs.length >= 2
      ? { poly: f.polyCoeffs, min: f.adcNormMin ?? 0, scale: f.adcNormScale ?? 1 }
      : undefined;
  if (state.fits) return { cubic: form(state.fits.cubic), linear: form(state.fits.linear) };
  const legacy = state.polyCoeffs && state.polyCoeffs.length >= 2
    ? { poly: state.polyCoeffs, min: state.adcNormMin, scale: state.adcNormScale }
    : undefined;
  return { cubic: legacy };
}

// Older captured points weigh less under robust RLS forgetting — fade them so recency reads at a
// glance. This matters for reading a robust fit, and is harmless for cubic.
const AgeDot = (props: { cx?: number; cy?: number; payload?: Row }) => {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null || payload?.psi == null) return null;
  return (
    <circle cx={cx} cy={cy} r={4} fill="#E5E7EB" fillOpacity={payload.op ?? 1} stroke="#9CA3AF" />
  );
};

const CURVE_COLORS = { cubic: '#38BDF8', linear: '#34D399', robust: '#A78BFA', physics: '#FB923C' } as const;

// Custom tooltip: recharts' default duplicates the numeric X value on a scatter/number axis, and
// its label text renders black. We render the ADC once, then one row per present series.
interface TipItem { name?: string; value?: number; color?: string; dataKey?: string }
function ChartTooltip({ active, payload, label, unit = 'psi' }: { active?: boolean; payload?: TipItem[]; label?: number; unit?: string }) {
  if (!active || !payload || payload.length === 0) return null;
  const seen = new Set<string>();
  const rows = payload
    .filter((p) => p.value != null && isFinite(p.value) && p.dataKey && p.dataKey !== 'adc')
    .filter((p) => { const k = String(p.dataKey); if (seen.has(k)) return false; seen.add(k); return true; });
  if (rows.length === 0) return null;
  return (
    <div style={{ background: '#111', border: '1px solid #333', borderRadius: 6, padding: '6px 8px', fontSize: 11 }}>
      <div style={{ color: '#e2e2e2', fontWeight: 600, marginBottom: 3 }}>ADC {Number(label).toExponential(3)}</div>
      {rows.map((p) => (
        <div key={String(p.dataKey)} style={{ color: p.color ?? '#e2e2e2', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span>{p.name ?? p.dataKey}</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{Number(p.value).toFixed(2)} {unit}</span>
        </div>
      ))}
    </div>
  );
}

export interface CalibrationChartProps {
  state?: CubicCalibrationChannel;
  height?: number;
  activeModel?: ChartModel;
  show?: { cubic?: boolean; linear?: boolean; robust?: boolean; physics?: boolean };
  physics?: PhysicsParams;
  /** LC datasheet physics params — mutually exclusive with `physics` (PT). */
  lcPhysics?: LcPhysicsParams;
  /** Value unit for axis/tooltip labels. Default 'psi' (PT); pass 'kg' for load cells. */
  unit?: 'psi' | 'kg';
}

/**
 * Shared calibration chart for the merged page. Draws the captured points (age-faded) plus up to
 * four model overlays — cubic and linear (the service's two fits), robust (service `fitCurve`),
 * physics (closed form) — with the active model emphasized. `show` gates each overlay; `physics`/`lcPhysics`
 * supplies the datasheet params from config (PT and LC use different physics formulas).
 */
export function CalibrationChart({ state, height = 420, activeModel, show, physics, lcPhysics, unit = 'psi' }: CalibrationChartProps) {
  const showCubic = show?.cubic ?? true;
  const showLinear = show?.linear ?? true;
  const showRobust = show?.robust ?? true;
  const showPhysics = show?.physics ?? true;

  const data = useMemo<Row[]>(() => {
    const pts = state?.points ?? [];
    const n = pts.length;
    const rows: Row[] = pts.map((p, i) => ({
      adc: p.adc,
      psi: p.psi,
      op: n > 1 ? 0.35 + 0.65 * (i / (n - 1)) : 1, // oldest→newest
    }));

    const [lo, hi] = physicsSweepRangeForTests(activeModel, pts, physics, lcPhysics);

    const N = 60;
    const fits = fitCurvesForTests(state);
    const cubic = showCubic && n >= 2 ? fits.cubic : undefined;
    const linear = showLinear && n >= 2 ? fits.linear : undefined;
    const hasPhysics = showPhysics && (physics || lcPhysics);
    if (cubic || linear || hasPhysics) {
      for (let i = 0; i <= N; i++) {
        const adc = lo + ((hi - lo) * i) / N;
        const row: Row = { adc };
        if (cubic) row.psiCubic = evalCubicNorm(adc, cubic.poly, cubic.min, cubic.scale);
        if (linear) row.psiLinear = evalCubicNorm(adc, linear.poly, linear.min, linear.scale);
        if (hasPhysics) row.psiPhysics = lcPhysics ? physicsKg(adc, lcPhysics) : physicsPsi(adc, physics!);
        rows.push(row);
      }
    }
    if (showRobust) {
      for (const c of state?.fitCurve ?? []) rows.push({ adc: c.adc, psiRobust: c.psi });
    }
    return rows.sort((a, b) => a.adc - b.adc);
  }, [state, showCubic, showLinear, showRobust, showPhysics, physics, lcPhysics, activeModel]);

  const w = (m: ChartModel) => (activeModel === m ? 3 : 1.5);
  const dash = (m: ChartModel) => (activeModel && activeModel !== m ? '4 3' : undefined);

  return (
    <div className="border border-gray-800 rounded bg-card p-2" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 12, right: 20, bottom: 28, left: 12 }}>
          <CartesianGrid stroke="#222" />
          <XAxis type="number" dataKey="adc" domain={['auto', 'auto']} stroke="#888"
                 tick={{ fontSize: 10, fill: '#888' }} tickFormatter={(v) => Number(v).toExponential(1)}>
            <Label value="Raw ADC code" position="bottom" offset={12} fill="#888" fontSize={11} />
          </XAxis>
          <YAxis type="number" stroke="#888" tick={{ fontSize: 10, fill: '#888' }}
                 tickFormatter={(v) => Number(v).toFixed(0)}>
            <Label value={unit === 'kg' ? 'Force (kg)' : 'Pressure (PSI)'} angle={-90} position="insideLeft" fill="#888" fontSize={11} />
          </YAxis>
          <Tooltip content={<ChartTooltip unit={unit} />} cursor={{ stroke: '#555', strokeDasharray: '3 3' }} />
          {showCubic && (
            <Line type="monotone" dataKey="psiCubic" stroke={CURVE_COLORS.cubic} dot={false}
                  strokeWidth={w('cubic')} strokeDasharray={dash('cubic')} connectNulls
                  isAnimationActive={false} name="cubic" />
          )}
          {showLinear && (
            <Line type="monotone" dataKey="psiLinear" stroke={CURVE_COLORS.linear} dot={false}
                  strokeWidth={w('linear')} strokeDasharray={dash('linear')} connectNulls
                  isAnimationActive={false} name="linear" />
          )}
          {showRobust && (
            <Line type="monotone" dataKey="psiRobust" stroke={CURVE_COLORS.robust} dot={false}
                  strokeWidth={w('robust')} strokeDasharray={dash('robust')} connectNulls
                  isAnimationActive={false} name="robust" />
          )}
          {showPhysics && (
            <Line type="monotone" dataKey="psiPhysics" stroke={CURVE_COLORS.physics} dot={false}
                  strokeWidth={w('physics')} strokeDasharray={dash('physics')} connectNulls
                  isAnimationActive={false} name="physics" />
          )}
          <Scatter dataKey="psi" shape={AgeDot} name="captured" isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export { CURVE_COLORS };
