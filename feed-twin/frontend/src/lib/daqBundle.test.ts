import { describe, expect, it } from 'vitest';
import type { StandSheet } from '@pid/standSheet';
import type { ChannelDef, Drawing } from '../api';
import { FORMAT, buildBundle, bundleSections, bundleSymbols, drawingHash, drawnLines, vesselLimit } from './daqBundle';

const node = (id: string, componentType: string, page: string, options: Record<string, string> = {}, label = id.toUpperCase()) =>
  ({ id, type: 'pid', position: { x: 0, y: 0 }, data: { componentType, label, page, options } });

const DRAWING = {
  nodes: [
    node('main', 'SOLENOID_VALVE', 'Rocket'),
    node('press', 'SOLENOID_VALVE', 'Rocket', { failState: 'open' }),
    node('pt', 'PT', 'Rocket'),
    node('hand', 'BALL_VALVE', 'GSE'),
    node('bottle', 'KBOTTLE', 'GSE'),
  ],
  edges: [
    { id: 'l1', source: 'pt', target: 'main' },
    { id: 'l2', source: 'hand', target: 'bottle' },
    { id: 'across', source: 'main', target: 'hand' },
  ],
} as unknown as Drawing;

const STAND: StandSheet = {
  svg: '<svg/>', width: 10, height: 10, boxes: {}, mates: {}, missing: { symbols: [], lines: [] },
};

const CH = (name: string, symbol: string, board: ChannelDef['board'] = 'sol12', slot = 1): ChannelDef =>
  ({ board, slot, name, symbol });

const build = (over: Partial<Parameters<typeof buildBundle>[0]> = {}) => buildBundle({
  stand: STAND, drawing: DRAWING, diagram: 'le4', artifact: 'art-1', sha256: 'abc',
  channels: [CH('LOX Main', 'main'), CH('Ox Upstream', 'pt', 'pt_low')],
  actuated: new Set(['main', 'press']), now: new Date('2026-11-17T12:00:00Z'), ...over,
});

describe('what each symbol tells the DAQ', () => {
  const symbols = bundleSymbols(DRAWING, new Set(['main', 'press']));

  it('gives an actuated valve its unpowered position, closed unless drawn open', () => {
    expect(symbols.main.normally).toBe('NC');
    expect(symbols.press.normally).toBe('NO');
  });

  it('gives no position to anything the DAQ does not energise', () => {
    // A hand valve is never on the table; a NO/NC on it would ring it.
    expect(symbols.hand.normally).toBeNull();
    expect(symbols.pt.normally).toBeNull();
  });

  it('carries type, tag and page', () => {
    expect(symbols.pt).toEqual({ type: 'PT', tag: 'PT', page: 'Rocket', normally: null });
  });

  it('calls an unlabelled symbol what it is, never its id', () => {
    const d = { nodes: [node('n1', 'PT', 'Main', {}, '')], edges: [] } as unknown as Drawing;
    expect(bundleSymbols(d, new Set()).n1.tag).toBe('unlabelled PT');
  });
});

describe('which lines the picture must carry', () => {
  it('is every line on one page, not one between pages', () => {
    expect(drawnLines(DRAWING)).toEqual(['l1', 'l2']);
  });
});

describe('the bundle', () => {
  it('carries the drawing, the cabled connectors and when it was made', () => {
    const out = build();
    if ('error' in out) throw new Error(out.error);
    expect(out.bundle.format).toBe(FORMAT);
    expect(out.bundle.drawing).toEqual({
      diagram: 'le4', artifact: 'art-1', sha256: 'abc', exported_at: '2026-11-17T12:00:00.000Z',
    });
    expect(out.bundle.channels.map((c) => c.name)).toEqual(['LOX Main', 'Ox Upstream']);
  });

  it('leaves out a connector with no cable', () => {
    const out = build({ channels: [CH('LOX Main', 'main'), CH('Spare', '', 'sol12', 2)] });
    if ('error' in out) throw new Error(out.error);
    expect(out.bundle.channels.map((c) => c.name)).toEqual(['LOX Main']);
  });

  it('refuses a picture that came back without a symbol or a line', () => {
    const out = build({ stand: { ...STAND, missing: { symbols: ['pt'], lines: ['l1'] } } });
    expect('error' in out && out.error).toMatch(/1 symbol\(s\) \(pt\) and 1 line\(s\) \(l1\)/);
  });

  it('refuses a cable to a symbol the drawing does not have', () => {
    const out = build({ channels: [CH('LOX Main', 'gone')] });
    expect('error' in out && out.error).toMatch(/LOX Main/);
  });
});

describe('which drawing a bundle was made from', () => {
  it('is a stable hash that changes with the drawing', async () => {
    const a = await drawingHash(DRAWING);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await drawingHash(DRAWING)).toBe(a);
    const moved = { ...DRAWING, edges: DRAWING.edges.slice(1) } as Drawing;
    expect(await drawingHash(moved)).not.toBe(a);
  });
});

describe('sections: what one pressure holds', () => {
  const n = (id: string, componentType: string, extra: Record<string, unknown> = {}) =>
    ({ id, type: 'pid', position: { x: 0, y: 0 }, data: { componentType, label: id.toUpperCase(), page: 'P', ...extra } });
  const e = (id: string, source: string, target: string) => ({ id, source, target });
  const psi = (value: number) => ({ value, unit: 'psi' });

  // bottle -- j -- sol -- tank, a PT on each side of the valve.
  const D = {
    nodes: [
      n('bottle', 'KBOTTLE', { params: { burst_pressure: psi(9000) } }),
      n('j', 'JUNCTION'), n('pt1', 'PT'), n('sol', 'SOL'),
      n('tank', 'TANK', { params: { burst_pressure: psi(1500) } }), n('pt2', 'PT'),
    ],
    edges: [e('a', 'bottle', 'j'), e('b', 'j', 'pt1'), e('c', 'j', 'sol'), e('d', 'sol', 'tank'), e('f', 'tank', 'pt2')],
  } as unknown as Drawing;

  const { sections, sectionOf } = bundleSections(D, {});
  const of = (line: string) => Object.entries(sections).find(([, s]) => s.lines.includes(line))![0];

  it('joins lines through a junction and a vessel, and splits them at a valve', () => {
    expect(of('a')).toBe(of('b'));
    expect(of('a')).toBe(of('c'));
    expect(of('d')).toBe(of('f'));
    expect(of('c')).not.toBe(of('d'));
  });

  it('puts each transducer on its own side of the valve', () => {
    expect(sectionOf.pt1).toBe(of('a'));
    expect(sectionOf.pt2).toBe(of('d'));
  });

  it('limits a section at its vessel: burst over the safety factor, gauge', () => {
    expect(sections[of('d')].limit).toEqual({ psig: 750, vessel: 'TANK', basis: 'burst', burst_psig: 1500, factor: 2 });
    expect(sections[of('a')].limit?.psig).toBe(4500);
  });

  it('prefers a drawn MAWP, and reads psia as absolute', () => {
    const l = vesselLimit({ label: 'T', params: { MAWP: { value: 514.696, unit: 'psia' }, burst_pressure: psi(1500) } });
    expect(l).toMatchObject({ vessel: 'T', basis: 'MAWP' });
    expect(l!.psig).toBeCloseTo(500, 2);
  });

  it('joins the two halves of a mated disconnect', () => {
    const M = {
      nodes: [n('pt1', 'PT'), n('qa', 'QD'), n('qb', 'QD'), n('pt2', 'PT')],
      edges: [e('x', 'pt1', 'qa'), e('y', 'qb', 'pt2')],
    } as unknown as Drawing;
    const apart = bundleSections(M, {});
    expect(apart.sectionOf.pt1).not.toBe(apart.sectionOf.pt2);
    const mated = bundleSections(M, { qa: 'qb', qb: 'qa' });
    expect(mated.sectionOf.pt1).toBe(mated.sectionOf.pt2);
  });

  it('finds a transducer clipped to a line', () => {
    const C = {
      nodes: [n('t', 'TANK'), n('v', 'SOL'), n('pt', 'PT', { attachedTo: 'l' })],
      edges: [e('l', 't', 'v')],
    } as unknown as Drawing;
    expect(bundleSections(C, {}).sectionOf.pt).toBe('s1');
  });

  it('on the shipped LE4, keeps the ox and fuel transducers apart', async () => {
    const { readFileSync } = await import('node:fs');
    const le4 = JSON.parse(readFileSync(new URL('../../../backend/sample/le4-stand.json', import.meta.url), 'utf8'));
    const doc = (le4.nodes ? le4 : le4.diagram) as Drawing;
    const tag = (label: string) => doc.nodes.find((x) => (x.data as { label?: string }).label === label)!.id;
    const { sectionOf: s } = bundleSections(doc, {});
    expect(s[tag('OU-PT-R')]).toBeDefined();
    expect(s[tag('FU-PT-R')]).toBeDefined();
    expect(s[tag('OU-PT-R')]).not.toBe(s[tag('FU-PT-R')]);
  });
});
