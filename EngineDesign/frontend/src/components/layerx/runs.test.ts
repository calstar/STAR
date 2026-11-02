import { describe, expect, it } from 'vitest';
import type { RunView } from '../../api/layerx';
import { DEFAULT_SYSTEM, makeUnits } from '../lx/units';
import { runFigures } from './runs';

describe('runFigures', () => {
  const flown = { status: 'done', summary: { total_impulse_Ns: 23810, apogee_agl_m: 3090 } } as unknown as RunView;

  it('writes the apogee in the page’s length unit', () => {
    // The run and compare menus printed '23.81 kN·s · 10,137 ft' beside an Overview reading 'Apogee 3,090 m'.
    const u = makeUnits(DEFAULT_SYSTEM);
    const line = runFigures(flown, (m) => u.fmt(u.alt(m)));
    expect(line).toBe(`23.81 kN·s · ${u.fmt(u.alt(3090))}`);
    expect(line).toMatch(/3,090 m$/);
    expect(line).not.toContain('ft');
  });

  it('keeps feet for a caller that names no unit (the old GUI)', () => {
    expect(runFigures(flown)).toBe('23.81 kN·s · 10,138 ft');
  });
});
