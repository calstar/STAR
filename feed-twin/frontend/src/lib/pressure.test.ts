import { describe, expect, it } from 'vitest';
import {
  ATMOSPHERE_PSI,
  PRESSURE_UNIT,
  asShown,
  commitPsia,
  daqReads,
  fmtP,
  fromPsia,
  isGaugeInput,
  isGaugeTunable,
  isPressureChannel,
  psiaEntry,
  psiaText,
  snapPsia,
  toPsia,
  typedPsia,
  unitLabel,
} from './pressure';

describe('the atmosphere is the library\'s', () => {
  it('is 101,325 Pa over one psi, 14.696', () => {
    // feedtwin.session.gauge: ATMOSPHERE = 101325.0, PSI = get_unit("psi").factor.
    expect(ATMOSPHERE_PSI).toBeCloseTo(14.6959487755, 9);
    expect(PRESSURE_UNIT).toBe('psia');
  });
});

describe('gauge and absolute', () => {
  it('a vented gauge is one atmosphere absolute', () => {
    expect(toPsia(0)).toBeCloseTo(14.696, 3);
    expect(fmtP(0, 1)).toBe('14.7 psia');
  });

  it('the trip from the dry runs reads as the vessel felt it', () => {
    // LOX tank 765.7 psig against its 750 psig MAWP: 780.4 and 764.7 psia.
    expect(fmtP(765.7, 1)).toBe('780.4 psia');
    expect(fmtP(750, 1)).toBe('764.7 psia');
  });

  it('round trips without drift', () => {
    for (const g of [0, 0.3, 500, 535, 4500, -1.05]) {
      expect(fromPsia(toPsia(g))).toBeCloseTo(g, 10);
    }
  });

  it('an idle chamber at the card\'s site ambient is positive absolute', () => {
    // D-41: 94,069.7 Pa at 626.67 m read -1.1 on a gauge face. Absolute it is
    // what the chamber holds, 13.6 psia, never negative.
    const gauge = (94069.7 - 101325) / 6894.757293168361;
    expect(gauge).toBeLessThan(0);
    expect(toPsia(gauge)).toBeCloseTo(13.64, 2);
    expect(psiaText(gauge, 1)).toBe('13.6');
  });
});

describe('what an input commits', () => {
  it('snaps to the detent in psia, then goes back to gauge', () => {
    // 517 psia typed on a 5 psi detent is 515 psia: 500.304 psig on the wire.
    expect(commitPsia(517, 5)).toBeCloseTo(515 - ATMOSPHERE_PSI, 10);
    expect(toPsia(commitPsia(517, 5))).toBeCloseTo(515, 10);
    // A knob turned one detent from the drawn 500 psig (514.7 psia) lands on
    // 520 psia, a whole detent, not 519.7.
    expect(toPsia(commitPsia(toPsia(500) + 5, 5))).toBeCloseTo(520, 10);
  });

  it('a zero step commits what was typed', () => {
    expect(commitPsia(514.7, 0)).toBeCloseTo(514.7 - ATMOSPHERE_PSI, 10);
  });

  it('takes the ends of a bounded field as detents', () => {
    // The dewar: vented (0 on the wire) is "fixed-rate load". 14.7 psia typed
    // must be that, not 15 psia -- a dewar pushing at 0.3 psi.
    expect(snapPsia(14.7, 5, 0, 500)).toBe(0);
    expect(snapPsia(16, 5, 0, 500)).toBeCloseTo(fromPsia(15), 10);
    expect(snapPsia(2, 5, 0, 500)).toBe(0);
    expect(snapPsia(9999, 5, 0, 500)).toBe(500);
    // Unbounded, it is commitPsia.
    expect(snapPsia(517, 5)).toBe(commitPsia(517, 5));
  });
});

describe('what a psia field shows', () => {
  it('is whole on a whole psia and a tenth off one', () => {
    expect(psiaEntry(500)).toBe('514.7');
    expect(psiaEntry(fromPsia(520))).toBe('520');
    expect(psiaEntry(0)).toBe('14.7');
  });
});

describe('which run inputs are gauge', () => {
  const setup = new Set(['setup.dome', 'setup.copv_target', 'setup.dewar_psi']);
  it('knows knobs, vessels at T-0 and the gauge setting rows', () => {
    expect(isGaugeInput('knobs.dome', setup)).toBe(true);
    expect(isGaugeInput('t0.tanks.TK-2.psig', setup)).toBe(true);
    expect(isGaugeInput('setup.dewar_psi', setup)).toBe(true);
  });
  it('leaves masses, temperatures and other settings alone', () => {
    expect(isGaugeInput('t0.tanks.TK-2.liquid_kg', setup)).toBe(false);
    expect(isGaugeInput('setup.chilldown', setup)).toBe(false);
    expect(isGaugeInput('hookup.knobs', setup)).toBe(false);
  });
});

describe('which channels are pressures', () => {
  it('takes the wire\'s default (no unit) as pressure', () => {
    expect(isPressureChannel({ unit: '' })).toBe(true);
    expect(isPressureChannel({})).toBe(true);
    expect(isPressureChannel({ unit: 'psig' })).toBe(true);
  });

  it('leaves temperature, thrust and O/F out', () => {
    for (const unit of ['K', 'N', 'O/F', 'kg/s']) expect(isPressureChannel({ unit })).toBe(false);
  });
});

describe('labels', () => {
  it('shows a gauge tag as psia and every other unit as itself', () => {
    expect(unitLabel('psig')).toBe('psia');
    expect(unitLabel('K')).toBe('K');
    expect(unitLabel('psi')).toBe('psi');
    expect(unitLabel('')).toBe('');
  });

  it('shows a value written in psig absolute, and others as written', () => {
    const shown = asShown({ value: 535, unit: 'psig' });
    expect(shown.unit).toBe('psia');
    expect(shown.value).toBeCloseTo(549.7, 1);
    expect(asShown({ value: 50, unit: 'psi' })).toEqual({ value: 50, unit: 'psi' });
    expect(asShown({ value: 2.5e6, unit: 'Pa' })).toEqual({ value: 2.5e6, unit: 'Pa' });
  });

  it('knows a gauge Configuration row before and after the backend says so', () => {
    expect(isGaugeTunable({ unit: 'psig' })).toBe(true);
    expect(isGaugeTunable({ unit: 'psia', gauge_wire: true })).toBe(true);
    expect(isGaugeTunable({ unit: 's' })).toBe(false);
    expect(isGaugeTunable({ unit: 'psi' })).toBe(false);
  });

  it('gives the DAQ\'s own gauge number on hover', () => {
    expect(daqReads(535)).toBe('DAQ reads 535.0 psig');
  });
});

describe('a field holds its own setting', () => {
  it('commits nothing when the box is only focused and left', () => {
    // The dewar at 100 psig shows 114.7; the knob at 500 shows 514.7; the
    // COPV at 4500 shows 4514.7. None is on a 5 psi detent, and leaving the
    // box once committed 100.304, 500.304, 4500.304.
    for (const value of [100, 500, 1000, 4500, 535]) {
      expect(typedPsia(psiaEntry(value), value, 5, 0, 5000)).toBeNull();
    }
  });

  it('keeps the setting when its shown number is typed back', () => {
    // Configuration's COPV row (step 50): 4514.7 typed back once committed
    // 4485.3 psig, 14.7 psi lower.
    expect(snapPsia(4514.7, 50, 0, 6000, 4500)).toBe(4500);
    expect(snapPsia(514.7, 5, 0, 1000, 500)).toBe(500);
    expect(typedPsia('514.7', 500, 5)).toBeNull();
    // A real edit still snaps to the detent in psia.
    expect(snapPsia(517, 5, 0, 1000, 500)).toBeCloseTo(fromPsia(515), 10);
    expect(typedPsia('520', 500, 5)).toBeCloseTo(fromPsia(520), 10);
  });

  it('keeps a Study cell inside its bounds', () => {
    // The Study's dewar cell: 14.7 psia typed is the vented end, not 0.3 psig.
    expect(snapPsia(14.7, 5, 0, 500, 100)).toBe(0);
    // A knob cell typed below an atmosphere never goes negative on the wire.
    expect(snapPsia(10, 1, 0, undefined, 500)).toBe(0);
  });
});
