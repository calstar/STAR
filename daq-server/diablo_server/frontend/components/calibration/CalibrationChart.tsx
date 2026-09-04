'use client'

import { useMemo } from 'react';
import {
  ComposedChart, Scatter, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Label,
} from 'recharts';
import { CubicCalibrationChannel } from '@/lib/types';

// The service supplies captured points, the cubic `polyCoeffs`, and a pre-sampled robust `fitCurve`.
// Physics is a closed form the browser evaluates directly. The browser never fits — it only draws
// the captured points plus each model's curve so you can compare them before choosing a model.

const ADC_MAX = 2147483648; // 2^31 — matches the service's ratiometric/4-20mA conversion scale.

export interface PhysicsParams {
  fullScale: number;        // PSI at full scale
  isLoop: boolean;          // true = 4-20 mA current loop, false = 0-5 V ratiometric
  senseResistor?: number;   // Ω (loop only)
  adcRefVoltage?: number;   // ADC reference volts (loop only; default 2.5)
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

function evalCubicNorm(adc: number, poly: number[], min: number, scale: number): number {
  const s = scale || 1;
  const x = (adc - min) / s;
  let xp = 1;
  let y = 0;
  for (let i = 0; i < poly.length; i++) { y += poly[i] * xp; xp *= x; }
  return y;
}

interface Row { adc: number; psi?: number; op?: number; psiCubic?: number; psiRobust?: number; psiPhysics?: number }

// Older captured points weigh less under robust RLS forgetting — fade them so recency reads at a
// glance. This matters for reading a robust fit, and is harmless for cubic.
const AgeDot = (props: { cx?: number; cy?: number; payload?: Row }) => {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null || payload?.psi == null) return null;
  return (
    <circle cx={cx} cy={cy} r={4} fill="#E5E7EB" fillOpacity={payload.op ?? 1} stroke="#9CA3AF" />
  );
};

const CURVE_COLORS = { cubic: '#38BDF8', robust: '#A78BFA', physics: '#FB923C' } as const;

export interface CalibrationChartProps {
  state?: CubicCalibrationChannel;
  height?: number;
  activeModel?: 'cubic' | 'robust' | 'physics';
  show?: { cubic?: boolean; robust?: boolean; physics?: boolean };
  physics?: PhysicsParams;
}

/**
 * Shared calibration chart for the merged page. Draws the captured points (age-faded) plus up to
 * three model overlays — cubic (from polyCoeffs), robust (service `fitCurve`), physics (closed
 * form) — with the active model emphasized. `show` gates each overlay; `physics` supplies the
 * datasheet params from config.
 */
export function CalibrationChart({ state, height = 420, activeModel, show, physics }: CalibrationChartProps) {
  const showCubic = show?.cubic ?? true;
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

    // Shared ADC sweep range: around the captured points if any, else the full physics range.
    let lo: number, hi: number;
    if (n >= 1) {
      const adcs = pts.map((p) => p.adc);
      lo = Math.min(...adcs);
      hi = Math.max(...adcs);
      const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.1 || 1;
      lo -= pad; hi += pad;
    } else {
      lo = 0; hi = ADC_MAX;
    }

    const N = 60;
    const poly = state?.polyCoeffs;
    const cubicOk = showCubic && poly && poly.length >= 2 && n >= 2;
    if (cubicOk || (showPhysics && physics)) {
      for (let i = 0; i <= N; i++) {
        const adc = lo + ((hi - lo) * i) / N;
        const row: Row = { adc };
        if (cubicOk) row.psiCubic = evalCubicNorm(adc, poly!, state!.adcNormMin, state!.adcNormScale);
        if (showPhysics && physics) row.psiPhysics = physicsPsi(adc, physics);
        rows.push(row);
      }
    }
    if (showRobust) {
      for (const c of state?.fitCurve ?? []) rows.push({ adc: c.adc, psiRobust: c.psi });
    }
    return rows.sort((a, b) => a.adc - b.adc);
  }, [state, showCubic, showRobust, showPhysics, physics]);

  const w = (m: 'cubic' | 'robust' | 'physics') => (activeModel === m ? 3 : 1.5);
  const dash = (m: 'cubic' | 'robust' | 'physics') => (activeModel && activeModel !== m ? '4 3' : undefined);

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
            <Label value="Pressure (PSI)" angle={-90} position="insideLeft" fill="#888" fontSize={11} />
          </YAxis>
          <Tooltip
            contentStyle={{ background: '#111', border: '1px solid #333', fontSize: 11 }}
            labelFormatter={(v) => `ADC ${Number(v).toExponential(3)}`}
            formatter={(val: number, name: string) => [Number(val).toFixed(2) + ' PSI', name]}
          />
          {showCubic && (
            <Line type="monotone" dataKey="psiCubic" stroke={CURVE_COLORS.cubic} dot={false}
                  strokeWidth={w('cubic')} strokeDasharray={dash('cubic')} connectNulls
                  isAnimationActive={false} name="cubic" />
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
