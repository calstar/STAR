import { describe, expect, it } from 'vitest';
import { drawingShelves } from '../useLayerXJob';
import { afterBurnout, soakFigures } from './soak';

describe('soak-back headline (D-60)', () => {
  it('quotes the bond line\'s peak and the outer face\'s 95 % time, never a 7.5 h "peak"', () => {
    // LE4 (6), as the run before 2026-10-17 recorded it: no summary of its own, stations only.
    const f = soakFigures({
      peak_K: 609.3, t_peak_s: 27072, t_95_s: 10440, station: 'throat', duration_s: 45103,
      stations: [{ station: 'throat', T_back_peak_K: 609.3, t_back_peak_s: 27072, t_back_95_s: 10440, T_interface_peak_K: 2265.2, t_interface_peak_s: 0.55 },
                 { station: 'exit', T_back_peak_K: 400, t_back_peak_s: 20000, t_back_95_s: 9000, T_interface_peak_K: 900, t_interface_peak_s: 2 }],
    });
    expect(f).toMatchObject({ bondK: 2265.2, bondT: 0.55, bondStation: 'throat', outerK: 609.3, outerT: 10440, asymptotic: true });
    expect(afterBurnout(0.55)).toEqual({ value: '+0.55', unit: 's' });
    expect(afterBurnout(600)).toEqual({ value: '+10.0', unit: 'min' });
    expect(afterBurnout(10440).unit).toBe('h');
    expect(afterBurnout(null).value).toBe('—');
  });
});

describe('drawing menu shelves (D-05)', () => {
  it('puts the team\'s stand first, then stands, then the benchmarks', () => {
    const d = (id: string, group: string, featured = false) => ({ id, name: id, source: '', sha256: '', added: 0, group, featured }) as never;
    const shelves = drawingShelves([d('he', 'Benchmarks'), d('le4', 'Stands', true), d('mine', 'Stands')]);
    expect(shelves.map(([s, l]) => [s, l.map((x) => x.id)])).toEqual([['The team’s stand', ['le4']], ['Stands', ['mine']], ['Benchmarks', ['he']]]);
  });
});
