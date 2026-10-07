import { describe, expect, it } from 'vitest';
import { OFF_DRAWING, groupByPage } from './pages';

const id = (s: string) => s;

describe('a panel split by sheet', () => {
  const pages = { COPV: 'Rocket', 'SV-MAIN': 'Rocket', 'SV-FILL': 'GSE', 'PT-CART': 'GSE' };

  it('draws a one-sheet stand as one group with no heading, as before', () => {
    const one = { A: 'Main', B: 'Main' };
    expect(groupByPage(['A', 'B'], ['A', 'B'], id, one)).toEqual([{ page: null, items: ['A', 'B'] }]);
  });

  it('draws a stand from an older server, with no pages, as one group', () => {
    expect(groupByPage(['A'], ['A'], id, undefined)).toEqual([{ page: null, items: ['A'] }]);
  });

  it('splits by sheet, in the drawing\'s order', () => {
    expect(groupByPage(['SV-FILL', 'SV-MAIN'], ['SV-FILL', 'SV-MAIN'], id, pages)).toEqual([
      { page: 'Rocket', items: ['SV-MAIN'] },
      { page: 'GSE', items: ['SV-FILL'] },
    ]);
  });

  it('keeps a sheet\'s heading when everything on it is hidden', () => {
    expect(groupByPage(['SV-FILL', 'SV-MAIN'], ['SV-MAIN'], id, pages)).toEqual([
      { page: 'Rocket', items: ['SV-MAIN'] },
      { page: 'GSE', items: [] },
    ]);
  });

  it('files what is not on the drawing last', () => {
    const groups = groupByPage(['engine.pc', 'PT-CART', 'COPV'], ['engine.pc', 'PT-CART', 'COPV'], id, pages);
    expect(groups.map((g) => g.page)).toEqual(['Rocket', 'GSE', OFF_DRAWING]);
  });
});
