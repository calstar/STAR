import { describe, expect, it } from 'vitest';
import { checksToFix, groupChecks } from './checks';

const LE4 = [
  "The engine is feedtwin's simplified model (one orifice per side, c* straight off the CEA table, no manifold or nozzle losses), not EngineDesign's: no engine card is stored.",
  'Eth-Tank has no diameter on the drawing; its static head assumes a 152 mm bore.',
  'LOX-Tank has no diameter on the drawing; its static head assumes a 152 mm bore.',
  'Fuel Transfer Tank has no volume on the drawing; its static head assumes 17.5 L.',
  'HP-Up-RV is a relief valve with no set_pressure, so it is read as shut -- a relief that never lifts. Give it a set_pressure (and its Cv) to model one that lifts and reseats.',
  'LP-RV is a relief valve with no set_pressure, so it is read as shut -- a relief that never lifts. Give it a set_pressure (and its Cv) to model one that lifts and reseats.',
  'QD-FFB and QD-FFA are paired, so they are read as one mated coupling joining pages GSE and Rocket.',
  '3 hand valve(s) rest shut until opened by hand: OF-MAN-Vent, OF-MAN-Fill, FV-MAN.',
  'A sentence no rule knows.',
];

describe('the checks, grouped', () => {
  it('folds one sentence per symbol into one line per kind', () => {
    const groups = groupChecks(LE4);
    const relief = groups.find((g) => g.title.startsWith('Relief valves'));
    expect(relief?.items).toEqual(['HP-Up-RV', 'LP-RV']);
    const diameter = groups.find((g) => g.title.startsWith('No diameter'));
    expect(diameter?.items).toEqual(['Eth-Tank', 'LOX-Tank']);
    expect(diameter?.title).toContain('152 mm');
    expect(groups.find((g) => g.title.startsWith('No volume'))?.title).toContain('17.5 L');
    expect(groups.find((g) => g.title.startsWith('Hand valves'))?.items).toEqual(['OF-MAN-Vent', 'OF-MAN-Fill', 'FV-MAN']);
  });

  it('never drops a sentence it does not know, and puts it where it will be read', () => {
    const groups = groupChecks(LE4);
    const unknown = groups.find((g) => g.title === 'A sentence no rule knows.');
    expect(unknown?.kind).toBe('fix');
  });

  it('counts only what is worth fixing for the tab', () => {
    // the simplified engine, two reliefs, the unknown sentence
    expect(checksToFix(LE4)).toBe(4);
  });
});
