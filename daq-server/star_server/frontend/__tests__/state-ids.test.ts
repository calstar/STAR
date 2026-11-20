/** State ids are hidden in the editor and assigned there (lib/states nextStateId / fixStateIds). */
import { describe, expect, it } from 'vitest';
import { nextStateId, fixStateIds } from '@/lib/states';

describe('nextStateId', () => {
  it('takes one above the highest id, never a deleted state\'s gap', () => {
    expect(nextStateId([])).toBe(1);
    expect(nextStateId([{ id: 1 }, { id: 3 }])).toBe(4);   // not 2: that was some other state
  });
  it('reuses a gap only once the next id would pass 254', () => {
    expect(nextStateId([{ id: 1 }, { id: 254 }])).toBe(2);
  });
});

describe('fixStateIds', () => {
  it('keeps the first holder of each id and gives repeats and missing ids fresh ones', () => {
    const out = fixStateIds([{ id: 5, name: 'A' }, { id: 5, name: 'B' }, { name: 'C' }, { id: 2, name: 'D' }]);
    expect(out.map((s) => [s.name, s.id])).toEqual([['A', 5], ['B', 6], ['C', 7], ['D', 2]]);
  });
  it('leaves a clean list untouched', () => {
    const list = [{ id: 1 }, { id: 4 }];
    expect(fixStateIds(list)).toEqual(list);
  });
});
