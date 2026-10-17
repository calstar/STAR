import { describe, expect, it } from 'vitest';
import type { Artifact, SessionState } from '../api';
import { defaultPicks, pastIdle } from './standPick';

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

describe('what switching away would throw away', () => {
  it('nothing, on a cold empty stand in Idle', () => {
    expect(pastIdle(stand('Idle', [tank('LOX', 0), tank('Fuel', 0)]), null)).toBe('');
  });
  it('a stand at Ready with its tanks loaded', () => {
    expect(pastIdle(stand('Ready', [tank('LOX', 6.7), tank('Fuel', 5.1)]), null)).toBe('in Ready, LOX and Fuel loaded');
  });
  it('a burn on screen, even back in Idle', () => {
    expect(pastIdle(stand('Idle', [tank('LOX', 0)]), { burns: [{}] } as never)).toBe('1 burn on screen');
  });
});
