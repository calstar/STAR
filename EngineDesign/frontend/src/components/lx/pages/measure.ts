import type { SweepFactor, SweepMetric, SweepResult } from '../../../api/layerx';
import type { GradedLimit } from '../useRunData';

/**
 * "Measure this next": of the limits the uncertainty sweep can speak to, take the closest (the
 * limits come worst-first), and rank the unmeasured inputs by how far each moves it. Pure.
 */

/** The sweep output that tracks a limit, by the limit's key (ported or the backend's). */
export function metricOf(l: Pick<GradedLimit, 'key' | 'focusKey'>): SweepMetric | null {
  const k = l.key;
  if (/^(stiff_lox|stiffness_ox|stiffness_lox|dp_pc_ox)$/.test(k)) return 'ox_stiffness_min';
  if (/^(stiff_fuel|stiffness_fuel|dp_pc_fuel)$/.test(k)) return 'fuel_stiffness_min';
  if (/^(bottle|bottle_over_lockup)$/.test(k)) return 'copv_end_psia';
  if (/sag/.test(k)) return l.focusKey === 'fuel_tank' || /fuel/.test(k) ? 'fuel_min_psia' : 'ox_min_psia';
  return null;
}

export interface MeasureNext {
  limit: GradedLimit;
  metric: SweepMetric;
  /** Largest swing first; only inputs that move it. */
  factors: { factor: SweepFactor; swing: number }[];
}

export function measureNext(limits: readonly GradedLimit[], sweep: Pick<SweepResult, 'factors'>): MeasureNext | null {
  for (const limit of limits) {
    if (limit.info) continue;
    const metric = metricOf(limit);
    if (!metric) continue;
    const factors = sweep.factors
      .map((factor) => ({ factor, swing: Math.abs(factor.swing[metric] ?? 0) }))
      .filter((x) => Number.isFinite(x.swing) && x.swing > 0)
      .sort((a, b) => b.swing - a.swing);
    if (factors.length) return { limit, metric, factors };
  }
  return null;
}
