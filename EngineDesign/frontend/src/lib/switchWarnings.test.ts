import { describe, expect, it } from 'vitest';
import { switchChips } from './switchWarnings';

const FLUIDS =
  'Fluid properties differ from the ethalox preset (configs/propellants/ethalox.yaml, sourced): ' +
  'LOX viscosity 0.00018 (preset 0.0002), LOX specific_heat 2300 (preset 1700).';
const SEED =
  'Chamber geometry was solved for propellant methalox -> ethalox. It is being used as a seed only.';

describe('switch chips', () => {
  it('a clean injector swap onto stale fluids does not read "needs re-optimization"', () => {
    const chips = switchChips({ design_warning: null, fluid_warning: FLUIDS });
    expect(chips.map((c) => c.label)).toEqual(['fluids differ from preset']);
    expect(chips[0].title).toBe(FLUIDS);
  });
  it('a propellant overlay is a seed', () => {
    expect(switchChips({ design_warning: SEED, fluid_warning: null })).toEqual([
      { label: 'needs re-optimization', title: SEED },
    ]);
  });
  it('both, each with its own sentence; neither, nothing', () => {
    expect(switchChips({ design_warning: SEED, fluid_warning: FLUIDS }).map((c) => c.title)).toEqual([SEED, FLUIDS]);
    expect(switchChips({})).toEqual([]);
  });
});
