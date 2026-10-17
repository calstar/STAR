import { describe, expect, it } from 'vitest';
import type { TankState } from '../api';
import { chillEndK, chillFraction, chillLeftS, underPressed, waitText } from '../components/PadSequence';

const tank = (over: Partial<TankState>) =>
  ({ id: 't', label: 'LOX', pressure_psi: 0, liquid_temperature_K: 293, ...over }) as TankState;

describe('the chill reads off the wall, not the liquid', () => {
  it('ends near LOX at one atmosphere while nothing has collected', () => {
    expect(chillEndK(tank({ liquid_temperature_K: 293 }))).toBeCloseTo(120.2, 1);
  });
  it('is part way while the wall cools', () => {
    expect(chillFraction(206.6, 293.15, 120.2)).toBeCloseTo(0.5, 2);
    expect(chillFraction(293.15, 293.15, 120.2)).toBe(0);
    expect(chillFraction(100, 293.15, 120.2)).toBe(1);
  });
  it('says how long to go at the rate it cools, and nothing when it does not', () => {
    expect(chillLeftS(206.6, 120.2, 0.29)).toBeCloseTo(298, 0);
    expect(chillLeftS(206.6, 120.2, 0)).toBeNull();
  });
  it('in words', () => {
    expect(waitText(42)).toBe('40 s');
    expect(waitText(298)).toBe('5 min');
    expect(waitText(3900)).toBe('1 h 5 min');
  });
});

describe('FIRE asks before a stand that was never pressed', () => {
  it('a tank with nothing on its dome is not pressed, whatever it reads', () => {
    expect(underPressed(tank({ pressure_psi: 0.5, lockup_psi: null, lockup_range_psi: [470, 520] }), 500)).toBe(true);
    // An older server: the unloaded regulator's sub-atmospheric "lockup".
    expect(underPressed(tank({ pressure_psi: 0.5, lockup_psi: -16.1 }), 500)).toBe(true);
  });
  it('a tank far under its lockup is not', () => {
    expect(underPressed(tank({ pressure_psi: 200, lockup_psi: 500 }), 500)).toBe(true);
  });
  it('a T-0 tank sagging 12 % under lockup is', () => {
    expect(underPressed(tank({ pressure_psi: 440, lockup_psi: 500 }), 500)).toBe(false);
  });
});
