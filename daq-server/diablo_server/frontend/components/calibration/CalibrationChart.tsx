'use client'

import { useMemo } from 'react';
import {
  ComposedChart, Scatter, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Label,
} from 'recharts';
import { CubicCalibrationChannel } from '@/lib/types';

// The service returns either cubic coeffs (evaluated here for the overlay) or a pre-sampled robust
// fitCurve. The browser never fits — it only draws captured points + the model's curve.
function evalCubicNorm(adc: number, poly: number[], min: number, scale: number): number {
  const s = scale || 1;
  const x = (adc - min) / s;
  let xp = 1;
  let y = 0;
  for (let i = 0; i < poly.length; i++) { y += poly[i] * xp; xp *= x; }
  return y;
}

interface Row { adc: number; psi?: number; psiFit?: number; op?: number }

// Older points weigh less under robust RLS forgetting — fade them so recency reads at a glance.
const AgeDot = (props: { cx?: number; cy?: number; payload?: Row }) => {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null || payload?.psi == null) return null;
  return (
    <circle cx={cx} cy={cy} r={4} fill="#F59E0B" fillOpacity={payload.op ?? 1} stroke="#F59E0B" />
  );
};

/**
 * Shared captured-points + fit-curve chart for both calibration pages. For a cubic channel the
 * overlay is sampled from `polyCoeffs`; for a robust channel it is the service-supplied `fitCurve`
 * (sampled `predict_pressure_psi`), and the captured points fade with age.
 */
export function CalibrationChart({ state, height = 420 }: { state?: CubicCalibrationChannel; height?: number }) {
  const isRobust = state?.active_model === 'robust';

  const data = useMemo<Row[]>(() => {
    const pts = state?.points ?? [];
    const n = pts.length;
    const rows: Row[] = pts.map((p, i) => ({
      adc: p.adc,
      psi: p.psi,
      // Robust: fade oldest→newest (0.35→1). Cubic weights points equally, so keep them solid.
      op: isRobust && n > 1 ? 0.35 + 0.65 * (i / (n - 1)) : 1,
    }));

    if (isRobust) {
      for (const c of state?.fitCurve ?? []) rows.push({ adc: c.adc, psiFit: c.psi });
    } else {
      const poly = state?.polyCoeffs;
      if (poly && poly.length >= 2 && pts.length >= 2) {
        const adcs = pts.map((p) => p.adc);
        let lo = Math.min(...adcs);
        let hi = Math.max(...adcs);
        const pad = (hi - lo) * 0.05 || 1;
        lo -= pad; hi += pad;
        const N = 60;
        for (let i = 0; i <= N; i++) {
          const adc = lo + ((hi - lo) * i) / N;
          rows.push({ adc, psiFit: evalCubicNorm(adc, poly, state!.adcNormMin, state!.adcNormScale) });
        }
      }
    }
    return rows.sort((a, b) => a.adc - b.adc);
  }, [state, isRobust]);

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
            formatter={(val: number, name: string) => [Number(val).toFixed(2) + ' PSI', name === 'psi' ? 'captured' : (isRobust ? 'robust' : 'fit')]}
          />
          <Line type="monotone" dataKey="psiFit" stroke="#38BDF8" dot={false} strokeWidth={2} connectNulls isAnimationActive={false} name="fit" />
          <Scatter dataKey="psi" shape={AgeDot} name="psi" isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
