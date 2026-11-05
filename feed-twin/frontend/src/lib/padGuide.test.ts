import { describe, expect, it } from 'vitest';
import type { SessionState, StandSetup, TankState } from '../api';
import { chargeDone, phaseDone, PAD_ORDER, chillEndK, chillFraction, chillLeftS, underPressed, waitText } from '../components/PadSequence';

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

describe('a charge spent on a press stays done', () => {
  const stand = (copv: number, lox: Partial<TankState>) =>
    ({
      bottles: [{ id: 'copv', pressure_psi: copv }],
      tanks: [
        tank({ id: 'lox', side: 'lox', liquid_temperature_K: 90, ...lox }),
        tank({ id: 'fuel', side: 'fuel', pressure_psi: 0.5, lockup_psi: 535 }),
      ],
    }) as unknown as SessionState;
  it('a charged COPV is charged', () => {
    expect(chargeDone(stand(3752, { pressure_psi: 40, lockup_psi: 535 }), 3735, 520)).toBe(true);
  });
  it('a COPV drawn down by the LOX press does not send the guide back to charge it', () => {
    expect(chargeDone(stand(3153, { pressure_psi: 538, lockup_psi: 538.3 }), 3735, 520)).toBe(true);
  });
  it('a COPV that was never charged is not', () => {
    expect(chargeDone(stand(3153, { pressure_psi: 40, lockup_psi: 535 }), 3735, 520)).toBe(false);
    // Nothing on the dome: a tank at any pressure is not pressed off it.
    expect(chargeDone(stand(3153, { pressure_psi: 538, lockup_psi: null, lockup_range_psi: [520, 560] }), 3735, 520)).toBe(false);
  });
});

describe('a press reached stays reached until it slips', () => {
  const setup = { dome: 535, copv_target: 3750 } as StandSetup;
  const stand = (lox: number) =>
    ({
      state: 'Fuel Press',
      bottles: [{ id: 'copv', pressure_psi: 2204 }],
      tanks: [
        tank({ id: 'lox', side: 'lox', liquid_temperature_K: 97, pressure_psi: lox, lockup_psi: 552.6, lockup_range_psi: [530, 585] }),
        tank({ id: 'fuel', side: 'fuel', pressure_psi: 544.7, lockup_psi: 552.6, lockup_range_psi: [530, 585] }),
      ],
    }) as unknown as SessionState;
  it('is done at lockup, and remembered', () => {
    const reached = new Set<string>();
    expect(phaseDone('oxpress', stand(552), setup, reached)).toBe(true);
    expect(reached.has('oxpress')).toBe(true);
  });
  it('a LOX tank sagged 10 % by the collapse is still pressed once reached, and not before', () => {
    expect(phaseDone('oxpress', stand(500), setup, new Set(['oxpress']))).toBe(true);
    expect(phaseDone('oxpress', stand(500), setup, new Set())).toBe(false);
  });
  it('past the slip it is not', () => {
    expect(phaseDone('oxpress', stand(400), setup, new Set(['oxpress']))).toBe(false);
  });
  it('Ready is never held', () => {
    const reached = new Set<string>();
    phaseDone('ready', { ...stand(552), state: 'Ready' } as SessionState, setup, reached);
    expect(reached.has('ready')).toBe(false);
  });
});

describe('the fuel loads first, so the LOX sits loaded for as short a time as it can', () => {
  it('fuel, then LOX, then the COPV', () => {
    const at = (k: string) => PAD_ORDER.indexOf(k);
    expect(at('fuel')).toBe(0);
    expect(at('ox')).toBe(1);
    expect(at('ox')).toBeLessThan(at('charge'));
  });
});

describe('the LOX is pressed last, and the guide does not walk back past it', () => {
  // LE4 (3) on GN2: the LOX press drew the COPV from 3,744 to 3,066 psia, and
  // the pressed LOX fell from 554 to 340 psia in 35 s once its solenoid shut.
  const setup = { dome: 535, copv_target: 3750 } as StandSetup;
  const stand = (copv: number, fuel: number, lox: number) =>
    ({
      state: 'Ox Press',
      bottles: [{ id: 'copv', pressure_psi: copv }],
      tanks: [
        tank({ id: 'lox', side: 'lox', liquid_temperature_K: 91, pressure_psi: lox, lockup_psi: 545, lockup_range_psi: [530, 585] }),
        tank({ id: 'fuel', side: 'fuel', pressure_psi: fuel, lockup_psi: 545, lockup_range_psi: [530, 585] }),
      ],
    }) as unknown as SessionState;
  it('fuel, then the top-up, then the LOX, then Ready', () => {
    const at = (k: string) => PAD_ORDER.indexOf(k);
    expect(at('fuelpress')).toBeLessThan(at('topup'));
    expect(at('topup')).toBeLessThan(at('oxpress'));
    expect(at('oxpress') + 1).toBe(at('ready'));
  });
  it('a COPV the LOX press drew down is not topped up again once the LOX is pressed', () => {
    expect(phaseDone('topup', stand(3051, 545, 545), setup, new Set(['topup', 'oxpress']))).toBe(true);
    // Before the LOX press, 81 % of the charge is past the slip.
    expect(phaseDone('topup', stand(3051, 545, 20), setup, new Set(['topup']))).toBe(false);
  });
  it('nor is a fuel tank pressed again behind it', () => {
    expect(phaseDone('fuelpress', stand(3051, 420, 545), setup, new Set(['fuelpress', 'topup', 'oxpress']))).toBe(true);
    expect(phaseDone('fuelpress', stand(3051, 420, 20), setup, new Set(['fuelpress']))).toBe(false);
  });
});
