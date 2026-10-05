import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SYSTEM, MINUS, NBSP, N_PER_LBF, PRESETS, PSI_PER_BAR, RESOLUTION, STD_ATM_PSIA, STORAGE_KEY,
  formatQ, loadSystem, makeUnits, numText, parseSystem, partsQ, resolutionText, saveSystem, scaleFor,
  type QuantityKind, type UnitSystem,
} from './units';

const si = makeUnits(PRESETS.si);
const stand = makeUnits(DEFAULT_SYSTEM);
const imp = makeUnits(PRESETS.imperial);

describe('constants', () => {
  it('are the exact definitions', () => {
    expect(PSI_PER_BAR).toBeCloseTo(14.503773773, 8);
    expect(N_PER_LBF).toBeCloseTo(4.4482216152605, 12);
    expect(STD_ATM_PSIA).toBeCloseTo(14.6959488, 6);
  });
});

describe('pressure', () => {
  it('psia is the model value, to 1 psi', () => {
    expect(stand.p(578.4)).toEqual({ value: 578.4, unit: 'psia', digits: 0 });
    expect(stand.fmt(stand.p(578.4))).toBe(`578${NBSP}psia`);
  });

  it('psig subtracts the gauge zero: the provider default, or the run\'s own', () => {
    expect(stand.p(578.4, 'gauge').value).toBeCloseTo(578.4 - STD_ATM_PSIA, 9);
    expect(stand.p(578.4, 'gauge').unit).toBe('psig');
    expect(stand.p(578.4, 'gauge', 12.5).value).toBeCloseTo(565.9, 9);
    const atAltitude = makeUnits(DEFAULT_SYSTEM, 12.5);
    expect(atAltitude.p(578.4, 'gauge').value).toBeCloseTo(565.9, 9);
  });

  it('bar(a) and bar(g) to 0.1 bar', () => {
    const a = si.p(578.4);
    expect(a.unit).toBe('bar(a)');
    expect(a.digits).toBe(1);
    expect(a.value).toBeCloseTo(578.4 / 14.503773773, 6);
    expect(si.fmt(a)).toBe(`39.9${NBSP}bar(a)`);
    const g = si.p(578.4, 'gauge');
    expect(g.unit).toBe('bar(g)');
    expect(g.value).toBeCloseTo((578.4 - STD_ATM_PSIA) / PSI_PER_BAR, 9);
    // One atmosphere absolute is 1.01325 bar(a), and zero gauge.
    expect(si.p(STD_ATM_PSIA).value).toBeCloseTo(1.01325, 9);
    expect(si.p(STD_ATM_PSIA, 'gauge').value).toBeCloseTo(0, 12);
  });

  it('a drop carries no gauge zero and one more digit', () => {
    expect(stand.dp(25.43)).toEqual({ value: 25.43, unit: 'psi', digits: 1 });
    expect(si.dp(14.503773773).value).toBeCloseTo(1, 9);
    expect(si.dp(1).digits).toBe(2);
  });

  it('a gap between levels has no gauge zero and the levels\' digits', () => {
    expect(stand.gap(631.4)).toEqual({ value: 631.4, unit: 'psi', digits: 0 });
    expect(si.fmt(si.gap(631.4))).toBe(`43.5${NBSP}bar`);
  });
});

describe('the other quantities', () => {
  it('force', () => {
    expect(stand.fmt(stand.f(6804.4))).toBe(`6,804${NBSP}N`);
    expect(imp.f(N_PER_LBF * 1530).value).toBeCloseTo(1530, 9);
    expect(imp.f(1).unit).toBe('lbf');
  });

  it('impulse: kN·s to 0.01, lbf·s to 1', () => {
    expect(stand.fmt(stand.impulse(24137))).toBe(`24.14${NBSP}kN·s`);
    expect(imp.impulse(N_PER_LBF * 5000).value).toBeCloseTo(5000, 9);
    expect(imp.impulse(1).digits).toBe(0);
  });

  it('mass and mass flow', () => {
    expect(imp.m(0.45359237).value).toBeCloseTo(1, 12);
    expect(stand.fmt(stand.m(6.5))).toBe(`6.50${NBSP}kg`);
    expect(imp.mdot(0.45359237).unit).toBe('lb/s');
    expect(stand.mdot(2.9).digits).toBe(3);
  });

  it('length, altitude and speed follow the length choice', () => {
    expect(stand.len(0.0254)).toEqual({ value: 25.4, unit: 'mm', digits: 2 });
    expect(imp.len(0.0254).value).toBeCloseTo(1, 12);
    expect(imp.len(0.0254).digits).toBe(3);
    expect(stand.alt(2950).unit).toBe('m');
    expect(imp.alt(2950).value).toBeCloseTo(2950 / 0.3048, 9);
    expect(imp.fmt(imp.alt(2950.5))).toBe(`9,680${NBSP}ft`);
    expect(imp.v(0.3048).value).toBeCloseTo(1, 12);
    expect(stand.v(12.34).unit).toBe('m/s');
  });

  it('fixed-unit quantities', () => {
    expect(stand.fmt(stand.temp(90.18))).toBe(`90.2${NBSP}K`);
    expect(stand.fmt(stand.isp(234.44))).toBe(`234.4${NBSP}s`);
    expect(stand.fmt(stand.of(1.4321))).toBe('1.43');
    expect(stand.fmt(stand.pct(0.356))).toBe(`35.6${NBSP}%`);
    expect(stand.fmt(stand.ratio(1.3333))).toBe('1.33');
    expect(stand.fmt(stand.time(1.854))).toBe(`1.85${NBSP}s`);
    expect(stand.fmt(stand.hz(112.4))).toBe(`112${NBSP}Hz`);
  });
});

describe('scale', () => {
  const kinds = Object.keys(RESOLUTION) as QuantityKind[];
  const systems: UnitSystem[] = [DEFAULT_SYSTEM, PRESETS.si, PRESETS.imperial];

  it('from() inverts to(), for every quantity in every system', () => {
    for (const sys of systems) {
      for (const kind of kinds) {
        for (const pressure of ['abs', 'gauge'] as const) {
          const s = scaleFor(sys, kind, { pressure, gaugeZeroPsia: 13.1 });
          for (const x of [0, 1, 578.4, -3.2]) expect(s.from(s.to(x))).toBeCloseTo(x, 9);
        }
      }
    }
  });

  it('every unit a scale can produce has a resolution row', () => {
    for (const sys of systems) {
      for (const kind of kinds) {
        for (const pressure of ['abs', 'gauge'] as const) {
          const s = scaleFor(sys, kind, { pressure });
          expect(RESOLUTION[kind][s.unit], `${kind} ${s.unit}`).toBe(s.digits);
          expect(Number.isInteger(s.digits)).toBe(true);
        }
      }
    }
  });
});

describe('formatting', () => {
  it('no value is a dash, never "NaN psia" or "0"', () => {
    expect(stand.fmt(stand.p(null))).toBe('—');
    expect(stand.fmt(stand.p(undefined))).toBe('—');
    expect(stand.fmt(stand.f(NaN))).toBe('—');
    expect(partsQ(stand.p(null))).toEqual({ num: '—', unit: '' });
    expect(formatQ(null)).toBe('—');
  });

  it('a negative number gets a true minus; a rounded-away one is plain zero', () => {
    expect(numText({ value: -2.94, digits: 1 })).toBe(`${MINUS}2.9`);
    expect(numText({ value: -0.004, digits: 1 })).toBe('0.0');
  });

  it('parts split the number from its unit', () => {
    expect(partsQ(stand.p(564.2))).toEqual({ num: '564', unit: 'psia' });
  });
});

describe('resolution text, for the glossary', () => {
  it('says each resolution once, in both systems', () => {
    expect(resolutionText('pressure')).toBe(`1${NBSP}psi or 0.1${NBSP}bar`);
    expect(resolutionText('force')).toBe(`1${NBSP}N or 1${NBSP}lbf`);
    expect(resolutionText('mass')).toBe(`0.01${NBSP}kg or 0.01${NBSP}lb`);
    expect(resolutionText('of')).toBe('0.01');
    expect(resolutionText('isp')).toBe(`0.1${NBSP}s`);
  });
});

describe('persistence', () => {
  function memory(): Storage {
    const m = new Map<string, string>();
    return {
      getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k),
      clear: () => m.clear(), key: () => null, get length() { return m.size; },
    };
  }

  it('round-trips a system', () => {
    const s = memory();
    saveSystem(PRESETS.imperial, s);
    expect(loadSystem(s)).toEqual(PRESETS.imperial);
  });

  it('falls back to the default on nothing stored, corrupt JSON, or a throwing store', () => {
    expect(loadSystem(memory())).toEqual(DEFAULT_SYSTEM);
    const s = memory();
    s.setItem(STORAGE_KEY, '{not json');
    expect(loadSystem(s)).toEqual(DEFAULT_SYSTEM);
    const throwing = { getItem: () => { throw new Error('SecurityError'); } };
    expect(loadSystem(throwing)).toEqual(DEFAULT_SYSTEM);
    expect(() => saveSystem(DEFAULT_SYSTEM, { setItem: () => { throw new Error('QuotaExceeded'); } })).not.toThrow();
  });

  it('rejects an impossible unit field by field', () => {
    expect(parseSystem({ pressure: 'atm', force: 'lbf', mass: 7 })).toEqual({ ...DEFAULT_SYSTEM, force: 'lbf' });
    expect(parseSystem(null)).toEqual(DEFAULT_SYSTEM);
    expect(parseSystem(['bar'])).toEqual(DEFAULT_SYSTEM);
  });
});
