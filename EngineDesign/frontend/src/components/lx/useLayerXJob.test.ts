import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type LayerXSettings } from '../../api/layerx';
import { heliumTwin, pickDrawing, restatedKey, withFeedTwinThermal, sectionsChanged, settingsDiff, stageOf, toolOf, whatIfHoles } from './useLayerXJob';

const base: LayerXSettings = { ...DEFAULT_SETTINGS, drawing_id: 'he' };
const names: Record<string, string> = { he: 'copv_study_he', gn2: 'copv_study_gn2' };
const name = (id: string) => names[id] ?? id;

describe('pickDrawing', () => {
  const drawings = [{ id: 'gn2', name: 'copv_study_gn2' }, { id: 'he', name: 'copv_study_he' }, { id: 's', name: 'ethalox_stand' }];

  it('keeps a stored drawing that still exists, even the old default', () => {
    expect(pickDrawing('gn2', drawings)).toBe('gn2');
    expect(pickDrawing('s', drawings)).toBe('s');
  });

  it('starts from helium only when nothing usable is stored', () => {
    expect(pickDrawing('', drawings)).toBe('he');
    expect(pickDrawing('deleted', drawings)).toBe('he');
  });

  it('falls back to the first, then to nothing', () => {
    expect(pickDrawing('', [{ id: 'x', name: 'other' }])).toBe('x');
    expect(pickDrawing('', [])).toBe('');
  });
});

describe('toolOf', () => {
  it('reads the old stored view, the trade study included', () => {
    expect(toolOf('burn')).toBe('burn');
    expect(toolOf('trade')).toBe('burn');
    expect(toolOf('reconcile')).toBe('injector');
    expect(toolOf('optimise')).toBe('optimize');
  });
});

describe('settingsDiff', () => {
  it('lists exactly what changed, in the rail\'s words and units', () => {
    const now = { ...base, tank_pressure_psia: 600, ullage_vapour: true, dt: 0.01 };
    const ran = { ...base, tank_pressure_psia: 578 };
    expect(settingsDiff(ran, now, name)).toEqual([
      { key: 'tank_pressure_psia', label: 'Tank pressure', from: '578.0 psia', to: '600.0 psia' },
      { key: 'ullage_vapour', label: 'Propellant vapour', from: 'the feed twin', to: 'on' },
      { key: 'dt', label: 'Time step', from: '50 ms', to: '10 ms' },
    ]);
  });

  it('says where an unset value comes from, and names drawings', () => {
    const d = settingsDiff({ ...base, drawing_id: 'gn2', tank_pressure_psia: 578 }, { ...base, tank_pressure_psia: null }, name);
    expect(d.map((c) => `${c.label} ${c.from} → ${c.to}`)).toEqual([
      'Drawing copv_study_gn2 → copv_study_he',
      'Tank pressure 578.0 psia → the design',
    ]);
  });

  it('ignores the liftoff mass of a burn that was never flown', () => {
    const off = { ...base, flight: false };
    expect(settingsDiff({ ...off, liftoff_mass_kg: 80 }, { ...off, liftoff_mass_kg: 90 }, name)).toEqual([]);
    expect(settingsDiff({ ...base, liftoff_mass_kg: 80 }, { ...base, liftoff_mass_kg: 90 }, name)).toHaveLength(1);
  });

  it('is empty for the same settings', () => {
    expect(settingsDiff(base, { ...base }, name)).toEqual([]);
  });
});

describe('restatedKey', () => {
  it('compares a run\'s restatements, not the vehicle\'s, in any order', () => {
    const a = [{ key: 'cv', value: 1 }, { key: 'cd', value: 0.7 }, { key: 'mass', value: 80, origin: 'vehicle' }];
    const b = [{ key: 'cd', value: 0.7 }, { key: 'cv', value: 1 }];
    expect(restatedKey(a)).toBe(restatedKey(b));
    expect(restatedKey(b)).not.toBe(restatedKey([{ key: 'cd', value: 0.71 }, { key: 'cv', value: 1 }]));
    expect(restatedKey(undefined)).toBe('[]');
  });
});

describe('whatIfHoles', () => {
  it('names the holes a what-if burned', () => {
    expect(whatIfHoles({ oxidizer: { d_jet: 0.001588 }, fuel: { d_jet: 0.0011906 } })).toBe('LOX 1.588 mm, fuel 1.191 mm');
    expect(whatIfHoles({ fuel: { impingement_angle: 60 } })).toBe('');
    expect(whatIfHoles(null)).toBe('');
  });
});

describe('stageOf', () => {
  const flown = { ...base, flight: true, replay: true };
  it('reads the backend\'s stage words', () => {
    expect(stageOf({ stage: 'Settling the T-0 state', settings: flown }).phase).toBe(0);
    const p = stageOf({ stage: 'Nozzle erosion, pass 2', settings: flown });
    expect(p).toMatchObject({ phase: 1, pass: 2, sub: 1, caption: 'Re-burning with the eroded throat', typical: 4 });
    expect(p.subs.map((s) => s.label)).toEqual(['Burn', 'Erosion', 'Flight']);
    expect(stageOf({ stage: 'Flight, pass 3', settings: flown }).caption).toBe("Re-burning with the eroded throat and the flight's acceleration");
    expect(stageOf({ stage: 'Checking', settings: flown }).phase).toBe(2);
  });

  it('leaves out the steps a burn does not take', () => {
    const pad = stageOf({ stage: 'Burning, pass 1', settings: { ...base, flight: false, replay: false } });
    expect(pad.subs.map((s) => s.key)).toEqual(['burn']);
    expect(pad).toMatchObject({ pass: 1, sub: 0, caption: 'As built', typical: 1 });
  });
});

describe('sectionsChanged', () => {
  const plain = { ...base, drawing_id: 'he' };
  it('marks nothing on the defaults', () => {
    expect(sectionsChanged(plain, 0)).toEqual({ drawing: false, before: false, simulate: false, advanced: false });
  });

  it('marks the section a changed value lives in', () => {
    expect(sectionsChanged({ ...plain, tank_pressure_psia: 600 }, 0).before).toBe(true);
    expect(sectionsChanged({ ...plain, pressurant: 'helium' }, 0).before).toBe(true);
    expect(sectionsChanged({ ...plain, replay: false }, 0).simulate).toBe(true);
    expect(sectionsChanged({ ...plain, ullage_vapour: true }, 0).advanced).toBe(true);
    expect(sectionsChanged(plain, 2).drawing).toBe(true);
  });

  it('ignores a value the run would not use', () => {
    expect(sectionsChanged({ ...plain, fill_fraction: 0.8 }, 0).advanced).toBe(false);
    expect(sectionsChanged({ ...plain, load: 'fill', fill_fraction: 0.8 }, 0).advanced).toBe(true);
    expect(sectionsChanged({ ...plain, flight: false, liftoff_mass_kg: 80 }, 0).simulate).toBe(true);
    expect(sectionsChanged({ ...plain, liftoff_mass_kg: 80 }, 0).simulate).toBe(true);
  });
});

describe('heliumTwin', () => {
  const ds = [{ id: 'g', name: 'copv_study_gn2' }, { id: 'h', name: 'copv_study_he' }, { id: 's', name: 'ethalox_stand' }];
  it('finds the helium drawing of a nitrogen one', () => {
    expect(heliumTwin(ds[0], ds)).toBe('h');
  });
  it('falls back to the hot-fire drawing, and to null when there is none', () => {
    expect(heliumTwin(ds[2], ds)).toBe('h');
    expect(heliumTwin(ds[2], [ds[2]])).toBeNull();
  });  it("never swaps somebody's own drawing for a shipped one", () => {
    // LE4, uploaded to the feed twin: "Use helium" used to replace it with
    // copv_study_he, so the run burned a different stand. Its own gas swaps.
    const mine = { id: 'le4', name: 'LE4 (1)', source: 'feed-twin library: upload' };
    expect(heliumTwin(mine, [...ds, mine])).toBeNull();
    const pulled = { id: 'p', name: 'my stand gn2', source: 'pid-designer:local/my-stand' };
    expect(heliumTwin(pulled, [...ds, pulled])).toBeNull();
  });
});

describe('withFeedTwinThermal', () => {
  it('hands the old all-off defaults back to the feed twin, keeps a real choice', () => {
    const old = { ullage_collapse: false, ullage_vapour: false, line_walls: false, chilldown: 0 };
    expect(withFeedTwinThermal(old)).toEqual({ ullage_collapse: null, ullage_vapour: null, line_walls: null, chilldown: null });
    const chosen = { ...old, line_walls: true };
    expect(withFeedTwinThermal(chosen)).toBe(chosen);
  });
});
