/** Video layouts (lib/video/layout.ts): preset geometry, and stand vs operator layouts. */
import { describe, it, expect } from 'vitest';
import { effectiveLayout, fingerprint, geometry, PRESETS, PRESET_SLOT_COUNTS, resolveSlots, withFocus, withSlot, type VideoLayout } from '@/lib/video/layout';

const ids = ['pad', 'eng', 'vents', 'lox'];

describe('preset geometry', () => {
  it('has as many cells as the preset has slots, all on the grid and none overlapping', () => {
    for (const p of PRESETS.filter((x) => x !== 'auto')) {
      const g = geometry(p);
      expect(g.cells.length, p).toBe(PRESET_SLOT_COUNTS[p]);
      const taken = new Set<string>();
      for (const c of g.cells) {
        for (let x = c.col; x < c.col + c.colSpan; x++) {
          for (let y = c.row; y < c.row + c.rowSpan; y++) {
            expect(x < g.cols && y < g.rows, `${p} cell off grid`).toBe(true);
            expect(taken.has(`${x},${y}`), `${p} overlap at ${x},${y}`).toBe(false);
            taken.add(`${x},${y}`);
          }
        }
      }
      expect(taken.size, `${p} leaves holes`).toBe(g.cols * g.rows);
    }
  });

  it('marks exactly the big slot as large', () => {
    expect(geometry('1+5').cells.map((c) => c.large)).toEqual([true, false, false, false, false, false]);
    expect(geometry('1x1').cells[0].large).toBe(true);
    expect(geometry('2x2').cells.some((c) => c.large)).toBe(false);
    expect(geometry('auto', 1).cells[0].large).toBe(true);
    expect(geometry('auto', 3).cells.some((c) => c.large)).toBe(false);
  });
});

describe('stand and operator layouts', () => {
  const stand: VideoLayout = { preset: '2x2', slots: ['pad', 'eng', null, 'gone'] };

  it('auto shows every stream in order; a preset shows its slots, dropping unknown streams', () => {
    expect(resolveSlots({ preset: 'auto', slots: [] }, ids)).toEqual(ids);
    expect(resolveSlots(stand, ids)).toEqual(['pad', 'eng', null, null]);
  });

  it('an operator swap shows on top of the stand layout', () => {
    const o = withSlot(stand, ids, null, 2, 'lox');
    const eff = effectiveLayout(stand, ids, o);
    expect(eff.slots).toEqual(['pad', 'eng', 'lox', null]);
    expect(eff.overridden).toBe(true);
  });

  it('focus is kept with the swaps, and clearing it keeps the swaps', () => {
    let o = withSlot(stand, ids, null, 2, 'lox');
    o = withFocus(stand, ids, o, 'eng');
    expect(effectiveLayout(stand, ids, o)).toMatchObject({ focus: 'eng', slots: ['pad', 'eng', 'lox', null] });
    o = withFocus(stand, ids, o, null);
    expect(effectiveLayout(stand, ids, o)).toMatchObject({ focus: null, slots: ['pad', 'eng', 'lox', null], overridden: true });
  });

  it('an operator\'s changes are ignored once the stand layout changes', () => {
    const o = withFocus(stand, ids, withSlot(stand, ids, null, 2, 'lox'), 'pad');
    const moved: VideoLayout = { ...stand, preset: '1+5', slots: ['vents'] };
    expect(o.base).toBe(fingerprint(stand, ids));
    expect(effectiveLayout(moved, ids, o)).toMatchObject({ focus: null, overridden: false, slots: ['vents', null, null, null, null, null] });
  });

  it('a focus on a stream that does not exist falls back to the grid', () => {
    // Same stand layout (base still valid), but the override names a stream that is not there
    // -- e.g. written by another window before a reload. The fingerprint alone cannot catch it.
    const two = ['pad', 'eng'];
    const o = { base: fingerprint(stand, two), slots: null, focus: 'lox' };
    expect(effectiveLayout(stand, two, o).focus).toBeNull();
  });
});
