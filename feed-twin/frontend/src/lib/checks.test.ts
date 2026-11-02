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

  it('names the hand valves only, not the advice after them', () => {
    // As feedtwin.pid.network says it: the names, then how to draw one that
    // stands open. The advice used to come out as the last valve's name.
    const said = '2 hand valve(s) rest shut until opened by hand: OV-MAN, FV-MAN. A hand valve that stands open '
      + "is drawn so: pid-designer's Normal position set to Normally open (normalPosition: open).";
    const hand = groupChecks([said]).find((g) => g.title.startsWith('Hand valves'));
    expect(hand?.items).toEqual(['OV-MAN', 'FV-MAN']);
    expect(hand?.detail).toBe(said);
  });

  it('says "no loss" only of a segment with no bore anywhere on its run', () => {
    // feedtwin.pid.segments, word for word. A bare stretch of a bored run is
    // sized at the run's narrowest bore -- priced, on an assumption.
    const groups = groupChecks([
      'LE4 (3):node_15-node_38 segment seg_1: itemised but states no bore, so neither its friction nor its '
        + 'fittings can be sized; it contributes nothing',
      'LE4 (3):ox-main segment seg_1: itemised but states no bore; its friction and fittings are sized at the '
        + "run's narrowest stated bore, 7.70 mm, which the drawing does not say",
      'LE4 (3):ox-main segment k1: states a K but no bore; the K is referred to the run\'s narrowest stated '
        + 'bore, 7.70 mm, which the drawing does not say',
      'LE4 (3):vent segment k2: states a K but no bore to refer it to, here or anywhere on the run; it '
        + 'contributes nothing',
    ]);
    const none = groups.find((g) => g.title.endsWith('they add no loss'));
    expect(none?.kind).toBe('fix');
    expect(none?.items).toEqual(['node_15-node_38 seg_1', 'vent k2']);
    const borrowed = groups.find((g) => g.title.includes('narrowest bore'));
    expect(borrowed?.kind).toBe('assumed');
    expect(borrowed?.items).toEqual(['ox-main seg_1', 'ox-main k1']);
  });

  it('never drops a sentence it does not know, and puts it where it will be read', () => {
    const groups = groupChecks(LE4);
    const unknown = groups.find((g) => g.title === 'A sentence no rule knows.');
    expect(unknown?.kind).toBe('fix');
  });

  it('counts only what is worth fixing for the tab, one per line it lists', () => {
    // the simplified engine, the reliefs (two of them, one line), the unknown sentence
    expect(checksToFix(LE4)).toBe(3);
    expect(checksToFix(LE4)).toBe(groupChecks(LE4).filter((g) => g.kind === 'fix').length);
  });
});
