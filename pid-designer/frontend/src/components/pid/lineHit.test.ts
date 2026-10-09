import { describe, expect, it } from 'vitest';
import { cornersOf, handToLine, handedOn, lineAt, lineElement, pageLines } from './lineHit';
import { crossingsOf, pathWithHops } from './hops';

describe('the line under a point', () => {
  it('measures against the pipe as drawn, not the straight line between ends', () => {
    // An L: out to the right, then down. Its two ends are (0,0) and (200,200),
    // and the point just below the top run is nowhere near the diagonal
    // between those ends -- which is exactly what the graph-level hit test
    // measures, and exactly what it gets wrong.
    const lines = [{ id: 'e1', d: 'M 0,0 L 200,0 L 200,200' }];
    expect(lineAt(lines, { x: 100, y: 4 })).toMatchObject({ id: 'e1', at: { x: 100, y: 0 } });
    // ...and a point on that diagonal is not on the pipe at all.
    expect(lineAt(lines, { x: 100, y: 100 })).toBeNull();
  });

  it('snaps to the pipe, so a junction lands on it', () => {
    expect(lineAt([{ id: 'e1', d: 'M 0,0 L 200,0' }], { x: 50, y: -9 })?.at)
      .toEqual({ x: 50, y: 0 });
  });

  it('takes the nearest of several', () => {
    const lines = [
      { id: 'near', d: 'M 0,0 L 100,0' },
      { id: 'far',  d: 'M 0,10 L 100,10' },
    ];
    expect(lineAt(lines, { x: 50, y: 3 })?.id).toBe('near');
    expect(lineAt(lines, { x: 50, y: 7 })?.id).toBe('far');
  });

  it('claims nothing beyond the tolerance', () => {
    const lines = [{ id: 'e1', d: 'M 0,0 L 200,0' }];
    expect(lineAt(lines, { x: 100, y: 40 })).toBeNull();
    expect(lineAt(lines, { x: 100, y: 40 }, 60)).toMatchObject({ id: 'e1' });
  });

  it('reads back only the corners of a line that hops another', () => {
    // A hop is drawn into the line's own path, so the path has a point where
    // each arc starts -- in the middle of a straight run. Read back as a
    // corner, it was stored on the halves of whatever was dropped there, and
    // drew a jog beside a line the drop had nothing to do with.
    const run = [{ x: 200, y: -100 }, { x: 200, y: 100 }, { x: 260, y: 100 }, { x: 260, y: 300 }];
    const others = [[{ x: 0, y: 30 }, { x: 400, y: 30 }], [{ x: 0, y: 200 }, { x: 265, y: 200 }]];
    const d = pathWithHops(run, crossingsOf(run, others));
    expect(d.match(/ A /g)).toHaveLength(2);
    const hit = lineAt([{ id: 'e1', d }], { x: 203, y: 60 })!;
    expect(hit.points).toEqual(run);
    expect(hit.at).toEqual({ x: 200, y: 60 });
  });

  it('claims nothing at all when there is nothing drawn', () => {
    expect(lineAt([], { x: 0, y: 0 })).toBeNull();
  });
});

describe('the lines on the page, read as the pointer moves', () => {
  it('are their corners, without their hops, and a path read before is not read again', () => {
    const run = [{ x: 200, y: -100 }, { x: 200, y: 100 }, { x: 260, y: 100 }];
    const hopped = pathWithHops(run, crossingsOf(run, [[{ x: 0, y: 30 }, { x: 400, y: 30 }]]));
    expect(hopped).toMatch(/ A /);
    const first = cornersOf(hopped);
    expect(first).toEqual(run);
    expect(cornersOf(hopped)).toBe(first);
    expect(cornersOf('M 0,0 L 50,0 L 100,0 L 100,40')).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }]);
  });

  it('are read off the page, and are none where there is no page', () => {
    const g = globalThis as unknown as { document?: unknown };
    expect(g.document).toBeUndefined();
    expect(pageLines()).toEqual([]);
    const el = (id: string, d: string) => ({ getAttribute: () => id, querySelector: () => ({ getAttribute: () => d }) });
    g.document = { querySelectorAll: () => [el('e1', 'M 0,0 L 50,0 L 100,0'), el('e2', 'M 0,10 L 0,90')] };
    try {
      expect(pageLines()).toEqual([
        { id: 'e1', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
        { id: 'e2', points: [{ x: 0, y: 10 }, { x: 0, y: 90 }] },
      ]);
    } finally { delete g.document; }
  });
});

describe('a click handed on to a line', () => {
  /** A page of two lines, recording what each is sent and whether it was sent as handed on. */
  function page() {
    const sent: { id: string; type: string; init: Record<string, unknown>; handed: boolean }[] = [];
    const el = (id: string) => ({
      getAttribute: (a: string) => (a === 'data-id' ? id : null),
      dispatchEvent: (e: { type: string; init: Record<string, unknown> }) => { sent.push({ id, type: e.type, init: e.init, handed: handedOn() }); return true; },
    });
    const g = globalThis as unknown as { document?: unknown; MouseEvent?: unknown };
    // An id with a quote in it: found by comparing, not by a selector built from it.
    const els = [el('a"b'), el('C-D')];
    g.document = { querySelectorAll: (sel: string) => (sel === '.react-flow__edge[data-id]' ? els : []) };
    g.MouseEvent = class { type: string; init: Record<string, unknown>; constructor(type: string, init: Record<string, unknown>) { this.type = type; this.init = init; } };
    return { sent, els, down: () => { delete g.document; delete g.MouseEvent; } };
  }
  const click = (type: string, more: Record<string, unknown> = {}) => {
    const did = { stopped: false, prevented: false };
    return {
      did, e: {
        type, clientX: 12, clientY: 34, button: 2, buttons: 2, detail: 1, altKey: false, ctrlKey: true, metaKey: false, shiftKey: true,
        stopPropagation() { did.stopped = true; }, preventDefault() { did.prevented = true; }, ...more,
      },
    };
  };

  it('is sent to that line\'s own element as the same click, and kept from what it landed on', () => {
    const shown = page();
    try {
      expect(lineElement('a"b')).toBe(shown.els[0]);
      const { e, did } = click('contextmenu');
      expect(handToLine('C-D', e)).toBe(true);
      expect(did).toEqual({ stopped: true, prevented: true });
      expect(shown.sent).toEqual([{
        id: 'C-D', type: 'contextmenu', handed: true, init: {
          bubbles: true, cancelable: true, clientX: 12, clientY: 34, button: 2, buttons: 2, detail: 1,
          altKey: false, ctrlKey: true, metaKey: false, shiftKey: true,
        },
      }]);
      // Only while it is being sent.
      expect(handedOn()).toBe(false);
    } finally { shown.down(); }
  });

  it('is left where it landed when the line is not on the page, or there is no page', () => {
    const shown = page();
    try {
      const { e, did } = click('click');
      expect(lineElement('X-Y')).toBeNull();
      expect(handToLine('X-Y', e)).toBe(false);
      expect(did).toEqual({ stopped: false, prevented: false });
      expect(shown.sent).toEqual([]);
    } finally { shown.down(); }
    const { e, did } = click('click');
    expect(lineElement('C-D')).toBeNull();
    expect(handToLine('C-D', e)).toBe(false);
    expect(did.stopped).toBe(false);
  });

  it('is not known as handed on once a handler it reached has thrown', () => {
    const shown = page();
    try {
      (shown.els[1] as { dispatchEvent: unknown }).dispatchEvent = () => { throw new Error('a handler failed'); };
      expect(() => handToLine('C-D', click('click').e)).toThrow('a handler failed');
      expect(handedOn()).toBe(false);
    } finally { shown.down(); }
  });
});
