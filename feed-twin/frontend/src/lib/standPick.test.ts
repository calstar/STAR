import { describe, expect, it } from 'vitest';
import type { Artifact, SessionState } from '../api';
import { RequestError } from '../api';
import {
  NO_ENGINE,
  defaultPicks,
  listIsBehind,
  networkChange,
  networkSwitch,
  openingKnobs,
  pastIdle,
  pendingWords,
  whyNotOpened,
} from './standPick';

const art = (id: string, kind: 'diagram' | 'engine', name: string, featured = false): Artifact => ({
  id,
  kind,
  name,
  sha256: id,
  size: 1,
  imported_at: '',
  source: '',
  notes: '',
  summary: {},
  ...(featured ? { featured: true } : {}),
});

// Newest first, as the library lists them: an import on top.
const library = [
  art('imp', 'diagram', 'Imported Stand'),
  art('eth', 'diagram', 'Ethalox Stand'),
  art('le4', 'diagram', 'LE4 (6)', true),
  art('e2', 'engine', 'Other engine'),
  art('e1', 'engine', 'ethalox 6800N', true),
];

describe('which stand a browser opens on', () => {
  it('a new viewer gets the featured stand, not the newest import', () => {
    expect(defaultPicks(library, {})).toEqual({ diagram: 'le4', engine: 'e1' });
  });
  it('this browser keeps its last stand', () => {
    expect(defaultPicks(library, { diagram: 'eth', engine: 'e2' })).toEqual({ diagram: 'eth', engine: 'e2' });
  });
  it('a remembered stand the library lost falls back to the featured one', () => {
    expect(defaultPicks(library, { diagram: 'gone' }).diagram).toBe('le4');
  });
  it('a link names it, by id or by name', () => {
    expect(defaultPicks(library, { diagram: 'eth' }, { diagram: 'LE4 (6)' }).diagram).toBe('le4');
    expect(defaultPicks(library, {}, { engine: 'e2' }).engine).toBe('e2');
  });
  it('with nothing featured, the old rule: a drawing named a stand', () => {
    const plain = library.map((a) => ({ ...a, featured: false }));
    expect(defaultPicks(plain, {}).diagram).toBe('imp');
  });
  it('an empty library opens nothing', () => {
    expect(defaultPicks([], {})).toEqual({ diagram: '', engine: '' });
  });
});

const tank = (label: string, kg: number) =>
  ({ id: label, label, liquid_mass_kg: kg }) as unknown as SessionState['tanks'][number];
const stand = (state: string, tanks: SessionState['tanks']) => ({ state, tanks }) as unknown as SessionState;

describe('a stand opened from elsewhere re-reads the library', () => {
  it('when the list on screen lacks its drawing or its engine', () => {
    expect(listIsBehind(library, ['imported-drawing', 'e1'])).toBe(true);
    expect(listIsBehind(library, ['le4', 'imported-engine'])).toBe(true);
  });
  it('not when it has both, nor for a stand with no engine', () => {
    expect(listIsBehind(library, ['le4', 'e1'])).toBe(false);
    expect(listIsBehind(library, ['le4', ''])).toBe(false);
  });
});

describe('where the knobs are on a fresh stand', () => {
  const saved = { dome: 535 };
  const turned = { diagram: 'le4', knobs: { dome: 600 } };
  it('Reset keeps a dome the operator turned, over the stand it was saved with', () => {
    expect(openingKnobs({ diagram: 'le4', saved, left: turned, standOpened: false, closed: null })).toEqual({ dome: 600 });
  });
  it('a stand opened just now puts its own knobs back', () => {
    expect(openingKnobs({ diagram: 'le4', saved, left: turned, standOpened: true, closed: null })).toEqual(saved);
  });
  it('after Close stand, Reset keeps the knobs turned since, not the closed stand\'s', () => {
    const closed = { diagram: 'le4', knobs: { dome: 535 } };
    expect(openingKnobs({ diagram: 'le4', saved: null, left: turned, standOpened: false, closed })).toEqual({ dome: 600 });
  });
  it('on another drawing, the last one\'s knobs are not this one\'s', () => {
    expect(openingKnobs({ diagram: 'eth', saved: null, left: turned, standOpened: false, closed: null })).toEqual({});
  });
  it('a reload has no session to keep: the stand\'s, or the closed stand\'s', () => {
    expect(openingKnobs({ diagram: 'le4', saved, left: null, standOpened: false, closed: null })).toEqual(saved);
    const closed = { diagram: 'le4', knobs: { dome: 520 } };
    expect(openingKnobs({ diagram: 'le4', saved: null, left: null, standOpened: false, closed })).toEqual({ dome: 520 });
  });
});

describe('a held switch says what it does', () => {
  const losing = 'in Ready, LOX and Fuel loaded';
  it('taking the engine off is not putting "the import" on', () => {
    const w = pendingWords({ kind: 'engine', id: '', name: 'Ethalox 7200N Doublet', losing });
    expect(w.ask).toBe('Take the engine Ethalox 7200N Doublet off the console? Fire will light nothing.');
    expect(w.ask).not.toMatch(/import/);
    expect(w.yes).toBe('Take it off');
  });
  it('a drawing or engine put on', () => {
    expect(pendingWords({ kind: 'diagram', id: 'eth', name: 'Ethalox Stand', losing }).ask).toBe(
      'Put the drawing Ethalox Stand on the console?',
    );
  });
  it('a stand document opened or saved asks its own question', () => {
    const w = pendingWords({ kind: 'stand', id: '', name: 'Open the stand LE4 (3)?', losing, yes: 'Open' });
    expect(w).toEqual({ ask: 'Open the stand LE4 (3)?', why: `The stand is ${losing}; this starts a fresh, empty stand.`, yes: 'Open' });
  });
  it('an engine taken off is remembered as none, and a reload does not put the featured one back', () => {
    expect(defaultPicks(library, { diagram: 'le4', engine: NO_ENGINE })).toEqual({ diagram: 'le4', engine: '' });
    expect(defaultPicks(library, { diagram: 'le4', engine: NO_ENGINE }, { engine: 'e2' }).engine).toBe('e2');
  });
});

describe('a stand that did not open says whose fault it is', () => {
  it('a build the server refused is the drawing\'s', () => {
    expect(whyNotOpened(new RequestError('COPV drawn as a TANK has no liquid to begin from.', 422))).toEqual({
      reason: 'COPV drawn as a TANK has no liquid to begin from.',
      drawing: true,
    });
  });
  it('a full server or a dropped connection is not, and is worth another go', () => {
    expect(whyNotOpened(new RequestError('The server is full: 8 stands are open and every one is being watched.', 503)).drawing).toBe(false);
    expect(whyNotOpened(new TypeError('Failed to fetch')).drawing).toBe(false);
  });
});

describe('the gas and the drawn GSE are a different network', () => {
  const setup = { ignore_gse: false, pressurant: '' };
  it('so changing one asks what it asks; anything else is not a network change', () => {
    expect(networkChange({ ignore_gse: true }, setup)).toBe('Ignore the drawn GSE and run the rocket alone?');
    expect(networkChange({ pressurant: 'helium' }, setup)).toBe('Switch the pressurant to helium?');
    expect(networkChange({ pressurant: '' }, setup)).toBe('');
    expect(networkChange({ ignore_gse: false }, setup)).toBe('');
  });
  it('never mid-burn; on a yes past Idle; at once on a cold stand', () => {
    expect(networkSwitch(stand('Fire', [tank('LOX', 3.1)]), null)).toBe('refuse');
    expect(networkSwitch(stand('Ready', [tank('LOX', 6.7)]), null)).toBe('ask');
    expect(networkSwitch(stand('Idle', [tank('LOX', 0)]), null)).toBe('now');
  });
});

describe('what switching away would throw away', () => {
  it('nothing, on a cold empty stand in Idle', () => {
    expect(pastIdle(stand('Idle', [tank('LOX', 0), tank('Fuel', 0)]), null)).toBe('');
  });
  it('a stand at Ready with its tanks loaded', () => {
    expect(pastIdle(stand('Ready', [tank('LOX', 6.7), tank('Fuel', 5.1)]), null)).toBe('in Ready, LOX and Fuel loaded');
  });
  it("not the cart's own tanks, which every fresh stand has loaded", () => {
    const fresh = stand('Idle', [tank('Eth-Tank', 0), tank('LOX-DW-350 PSI', 17.8), tank('Fuel Transfer Tank', 13.1)]);
    expect(pastIdle(fresh, null, new Set(['LOX-DW-350 PSI', 'Fuel Transfer Tank']))).toBe('');
    expect(networkSwitch(fresh, null, new Set(['LOX-DW-350 PSI', 'Fuel Transfer Tank']))).toBe('now');
    const loaded = stand('Idle', [tank('Eth-Tank', 4.4), tank('LOX-DW-350 PSI', 17.8)]);
    expect(pastIdle(loaded, null, new Set(['LOX-DW-350 PSI']))).toBe('Eth-Tank loaded');
  });
  it('a burn on screen, even back in Idle', () => {
    expect(pastIdle(stand('Idle', [tank('LOX', 0)]), { burns: [{}] } as never)).toBe('1 burn on screen');
  });
});
