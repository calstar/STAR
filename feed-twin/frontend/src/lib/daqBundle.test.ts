import { describe, expect, it } from 'vitest';
import type { StandSheet } from '@pid/standSheet';
import type { ChannelDef, Drawing } from '../api';
import { FORMAT, buildBundle, bundleSymbols, drawingHash, drawnLines } from './daqBundle';

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
