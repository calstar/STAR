import { describe, expect, it } from 'vitest';
import type { SweepFactor } from '../../../api/layerx';
import type { GradedLimit } from '../useRunData';
import { measureNext, metricOf } from './measure';

const L = (key: string, over: Partial<GradedLimit> = {}): GradedLimit => ({
  key, label: key, kind: 'ratio', value: 1, spec: { limit: 0, direction: 'higher-is-safer' }, status: 'ok', margin: 1, worstT: null,
  worstWord: 'at', focusKey: key, hint: '', text: () => ({ value: '', limit: '' }), ...over,
});
const F = (key: string, swing: Partial<SweepFactor['swing']>): SweepFactor => ({
  key, label: key, group: 'feed', basis: '', cases: {}, swing: swing as SweepFactor['swing'],
});

describe('measureNext', () => {
  it('maps limits to the sweep outputs that track them', () => {
    expect(metricOf(L('stiff_fuel'))).toBe('fuel_stiffness_min');
    expect(metricOf(L('stiffness_ox'))).toBe('ox_stiffness_min');
    expect(metricOf(L('bottle_over_lockup'))).toBe('copv_end_psia');
    expect(metricOf(L('sag', { focusKey: 'fuel_tank' }))).toBe('fuel_min_psia');
    expect(metricOf(L('sag', { focusKey: 'lox_tank' }))).toBe('ox_min_psia');
    expect(metricOf(L('chug'))).toBeNull();
  });

  it('takes the closest limit the sweep speaks to, and ranks the inputs by their swing on it', () => {
    // Worst first: chug (no sweep output), then fuel ΔP/Pc, then the bottle.
    const limits = [L('chug'), L('stiff_fuel'), L('bottle')];
    const sweep = { factors: [F('cd', { fuel_stiffness_min: 0.01, copv_end_psia: 500 }), F('reg', { fuel_stiffness_min: -0.03 }), F('none', { fuel_stiffness_min: 0 })] };
    const m = measureNext(limits, sweep)!;
    expect(m.limit.key).toBe('stiff_fuel');
    expect(m.metric).toBe('fuel_stiffness_min');
    expect(m.factors.map((f) => f.factor.key)).toEqual(['reg', 'cd']);
    expect(m.factors[0].swing).toBeCloseTo(0.03);
  });

  it('skips info limits and limits nothing moves; null when none is left', () => {
    expect(measureNext([L('stiff_fuel', { info: true })], { factors: [F('cd', { fuel_stiffness_min: 0.01 })] })).toBeNull();
    const m = measureNext([L('stiff_lox'), L('bottle')], { factors: [F('cd', { ox_stiffness_min: 0, copv_end_psia: 40 })] });
    expect(m?.limit.key).toBe('bottle');
    expect(measureNext([L('chug')], { factors: [] })).toBeNull();
  });
});
