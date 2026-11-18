import { describe, expect, it } from 'vitest';
import { CAPTION, GAP, composeStand, mateLabel, matesOf } from './standSheet';
import type { SheetShot, StandNode } from './standSheet';

/** A sheet as shootSheet hands it back: tagged symbols and lines in a foreignObject. */
const shot = (page: string, width: number, height: number, symbols: string[], lines: string[]): SheetShot => ({
  page, width, height, origin: { x: 10, y: 20 }, scale: 2,
  svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    '<foreignObject x="0" y="0" width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">' +
    symbols.map(id => `<div class="react-flow__node" data-id="${id}" data-pid-symbol="${id}"></div>`).join('') +
    '<svg>' + lines.map(id => `<g class="react-flow__edge" data-id="${id}" data-pid-line="${id}"></g>`).join('') + '</svg>' +
    '</div></foreignObject></svg>',
});

const node = (id: string, page: string, extra: Partial<StandNode> = {}): StandNode =>
  ({ id, page, label: id.toUpperCase(), x: 100, y: 50, width: 40, height: 30, ...extra });

const ROCKET = [node('tank', 'Rocket'), node('qd-v', 'Rocket', { pairedWith: 'qd-g' })];
const GSE = [node('bottle', 'GSE'), node('qd-g', 'GSE')];

describe('the whole stand as one picture', () => {
  const stand = composeStand(
    [shot('Rocket', 800, 600, ['tank', 'qd-v'], ['l1']), shot('GSE', 500, 900, ['bottle', 'qd-g'], ['l2'])],
    [...ROCKET, ...GSE], ['l1', 'l2'],
  );

  it('puts every page side by side under its name', () => {
    expect(stand.width).toBe(800 + GAP + 500);
    expect(stand.height).toBe(CAPTION + 900);
    expect(stand.svg).toContain('<svg x="0" y="72" data-pid-page="Rocket"');
    expect(stand.svg).toContain(`<svg x="${800 + GAP}" y="72" data-pid-page="GSE"`);
    expect(stand.svg).toMatch(/data-pid-page-name="GSE">GSE<\/text>/);
  });

  it('finds every symbol and line it was asked for', () => {
    expect(stand.missing).toEqual({ symbols: [], lines: [] });
  });

  it('says which symbols and lines a sheet came back without', () => {
    // A shot taken before the tags went on, or of the wrong page, must not
    // pass: the DAQ would paint readings onto nothing.
    const bare = composeStand(
      [shot('Rocket', 800, 600, ['tank'], []), shot('GSE', 500, 900, ['bottle', 'qd-g'], ['l2'])],
      [...ROCKET, ...GSE], ['l1', 'l2'],
    );
    expect(bare.missing).toEqual({ symbols: ['qd-v'], lines: ['l1'] });
  });

  it('places each box in stand pixels, page offset included', () => {
    // flow (100, 50) at scale 2 from origin (10, 20), under the caption.
    expect(stand.boxes.tank).toEqual([10 + 200, CAPTION + 20 + 100, 80, 60]);
    expect(stand.boxes.bottle).toEqual([800 + GAP + 10 + 200, CAPTION + 20 + 100, 80, 60]);
  });

  it('labels each half of a disconnect pair with its mate', () => {
    expect(stand.mates).toEqual({ 'qd-v': 'qd-g', 'qd-g': 'qd-v' });
    expect(stand.svg).toContain('data-pid-mate="qd-v">⇄ QD-G (GSE)</text>');
    expect(stand.svg).toContain('data-pid-mate="qd-g">⇄ QD-V (Rocket)</text>');
  });

  it('refuses a sheet that is not an SVG', () => {
    expect(() => composeStand([{ ...shot('Rocket', 1, 1, [], []), svg: '<div/>' }], [], []))
      .toThrow(/Rocket/);
  });

  it('escapes a page name and a tag', () => {
    const odd = composeStand([shot('A&B "x"', 10, 10, ['n'], [])], [node('n', 'A&B "x"', { label: '<n>' })], []);
    expect(odd.svg).toContain('data-pid-page="A&amp;B &quot;x&quot;"');
    expect(odd.missing.symbols).toEqual([]);
  });
});

describe('which disconnects are a pair', () => {
  it('takes a pairing written on one half for both', () => {
    expect(matesOf([node('a', 'P', { pairedWith: 'b' }), node('b', 'Q')])).toEqual({ a: 'b', b: 'a' });
  });

  it('leaves two halves naming different partners unmated, as feed-twin does', () => {
    const nodes = [node('a', 'P', { pairedWith: 'b' }), node('b', 'Q', { pairedWith: 'c' }), node('c', 'Q')];
    // b-c agree (c says nothing); a names b but b names c.
    expect(matesOf(nodes)).toEqual({ b: 'c', c: 'b' });
  });

  it('ignores a pairing with a symbol the drawing lost, or with itself', () => {
    expect(matesOf([node('a', 'P', { pairedWith: 'gone' }), node('b', 'P', { pairedWith: 'b' })])).toEqual({});
  });

  it('names the mate, and its page only when it is another', () => {
    expect(mateLabel(node('a', 'P'), node('b', 'P'))).toBe('⇄ B');
    expect(mateLabel(node('a', 'P'), node('b', 'Q', { label: '' }))).toBe('⇄ b (Q)');
  });
});
