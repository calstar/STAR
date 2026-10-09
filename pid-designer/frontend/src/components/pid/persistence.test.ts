// What the canvas sends the server, and when (PIDDesigner.tsx): the load,
// the debounced autosave and the flush on hide, cut out of the canvas as
// written (canvasSource.ts) and run in order, with the server stood in for.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import * as api from '../../api/diagrams';
import { migrate } from './migrate';
import { canvasStatement, compiled } from './canvasSource';

type G = { nodes: Node[]; edges: Edge[] };
const text = (g: G) => JSON.stringify(api.toStored(g));
const valve = (id: string, x: number): Node =>
  ({ id, type: 'MAN', position: { x, y: 0 }, data: { componentType: 'MAN', label: id, page: 'Main' } }) as Node;

const loadEffect = compiled(canvasStatement("// Load the selected diagram's working copy"),
  ['useEffect', 'loadedId', 'api', 'diagramRef', 'migrate', 'seedIdsFrom', 'setNodes', 'setEdges', 'resetHistory',
    'lastSaved', 'diagramKey', 'landOnPage']);
const autosaveEffect = compiled(canvasStatement('// Debounced autosave of the working copy'),
  ['useEffect', 'loadedId', 'diagramKey', 'readOnlyRef', 'api', 'nodes', 'edges', 'lastSaved', 'unsnapped',
    'diagramRef', 'onForbidden', 'onLockLost', 'inFlight']);
const flushEffect = compiled(canvasStatement('// Best-effort flush to S3 on tab close / hide'),
  ['useEffect', 'loadedId', 'diagramKey', 'readOnlyRef', 'api', 'snapshot', 'lastSaved', 'unsnapped', 'diagramRef',
    'window', 'document']);
const saveNowStatement = compiled(canvasStatement('// Giving the checkout back has to wait for this.'),
  ['useCallback', 'saveNowRef', 'inFlight', 'loadedId', 'diagramKey', 'readOnlyRef', 'snapshot', 'api', 'lastSaved',
    'unsnapped', 'diagramRef']);

/** The canvas's state and refs, and a server that records what it is sent. */
async function open(stored: G) {
  const refs = {
    loadedId: { current: null as string | null }, lastSaved: { current: '' }, unsnapped: { current: false },
    inFlight: { current: null as Promise<unknown> | null },
  };
  let g: G = { nodes: [], edges: [] };
  const sent = { autosaves: [] as string[], beacons: [] as string[], stringified: 0 };
  /** Set, and the next autosave is held on the wire until it is called. */
  let hold: { release?: () => void } | null = null;
  const server = {
    ...api,
    loadDiagram: () => Promise.resolve(structuredClone(stored)),
    toStored: (x: G) => { sent.stringified++; return api.toStored(x); },
    autosaveDiagram: (_: unknown, x: G) => {
      const body = text(x);
      if (hold) {
        const h = hold; hold = null;
        return new Promise<{ ok: boolean; micro: boolean }>(res => { h.release = () => { sent.autosaves.push(body); res({ ok: true, micro: false }); }; });
      }
      sent.autosaves.push(body);
      return Promise.resolve({ ok: true, micro: false });
    },
    flushDiagram: (_: unknown, x: G) => { sent.beacons.push(text(x)); },
  };
  const run = (f: () => void | (() => void)) => { f(); };
  loadEffect(run, refs.loadedId, server, { id: 'd' }, migrate, () => {}, (n: Node[]) => { g = { ...g, nodes: n }; },
    (e: Edge[]) => { g = { ...g, edges: e }; }, () => {}, refs.lastSaved, 'd', () => {});
  await Promise.resolve(); await Promise.resolve();
  // The flush effect, registered once, and its listeners.
  const heard: Record<string, () => void> = {};
  const target = { addEventListener: (k: string, f: () => void) => { heard[k] = f; }, removeEventListener: () => {} };
  const doc = { ...target, visibilityState: 'hidden' };
  flushEffect(run, refs.loadedId, 'd', { current: false }, server, { get current() { return g; } }, refs.lastSaved,
    refs.unsnapped, { id: 'd' }, target, doc);
  /** A render: the drawing as it now is, handed to the autosave effect; its cleanup, the next render's. */
  let cleanup: (() => void) | void;
  const render = (next: G) => {
    g = next;
    if (typeof cleanup === 'function') cleanup();
    cleanup = undefined;
    autosaveEffect((f: () => void | (() => void)) => { cleanup = f(); }, refs.loadedId, 'd', { current: false }, server,
      g.nodes, g.edges, refs.lastSaved, refs.unsnapped, { id: 'd' }, () => {}, () => {}, refs.inFlight);
  };
  // What the checkout's Release awaits before giving the hold back.
  const saveNowRef = { current: (): Promise<void> => Promise.resolve() };
  saveNowStatement(<T>(f: T) => f, saveNowRef, refs.inFlight, refs.loadedId, 'd', { current: false },
    { get current() { return g; } }, server, refs.lastSaved, refs.unsnapped, { id: 'd' });
  const holdNextSave = () => { const h: { release?: () => void } = {}; hold = h; return () => h.release!(); };
  return {
    get: () => g, render, hide: () => heard.visibilitychange(), close: () => heard.pagehide(), sent, refs,
    saveNow: () => saveNowRef.current(), holdNextSave,
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('the autosave', () => {
  it('writes the drawing out once, when the timer fires, however many changes came before', () => {
    // A drag changes the drawing twice a tick -- the step and the reseat's
    // correction -- and every change serialised the whole drawing before
    // the debounce threw all but the last away.
    return open({ nodes: [valve('A', 0)], edges: [] }).then(c => {
      c.sent.stringified = 0;
      for (let k = 1; k <= 60; k++) c.render({ nodes: [valve('A', k)], edges: [] });
      expect(c.sent.stringified).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(c.sent.stringified).toBe(1);
      expect(c.sent.autosaves).toEqual([text({ nodes: [valve('A', 60)], edges: [] })]);
    });
  });

  it('sends nothing for a change that changes nothing it stores', () => {
    return open({ nodes: [valve('A', 0)], edges: [] }).then(c => {
      c.render({ nodes: [{ ...c.get().nodes[0], selected: true }], edges: [] });
      vi.advanceTimersByTime(1000);
      expect(c.sent.autosaves).toEqual([]);
    });
  });
});

describe('the flush on hide', () => {
  it('sends nothing for a drawing opened and not edited, however often the tab is hidden', () => {
    // Opened, a drawing is put through `migrate` (and the reseat), and what
    // they make of it is kept off the server until somebody edits it. The
    // beacon sent it -- a microversion -- on the first hide, and every one.
    const old = { nodes: [{ id: 'n1', type: 'INJECTOR', position: { x: 0, y: 0 }, data: { componentType: 'INJECTOR', label: 'INJ-1', page: 'Main' } } as Node], edges: [] };
    return open(old).then(c => {
      expect(text(c.get())).not.toBe(text(old));
      c.hide(); c.hide(); c.close();
      expect(c.sent.beacons).toEqual([]);
    });
  });

  it('sends an edit the autosave has not, and one it has sent but the server has not snapshotted, once', () => {
    return open({ nodes: [valve('A', 0)], edges: [] }).then(c => {
      // Edited, and hidden inside the debounce: the edit is the beacon's.
      c.render({ nodes: [valve('A', 10)], edges: [] });
      c.hide();
      expect(c.sent.beacons).toEqual([text({ nodes: [valve('A', 10)], edges: [] })]);
      vi.advanceTimersByTime(1000);
      expect(c.sent.autosaves).toEqual([]);
      // Edited and autosaved, not yet snapshotted: the beacon snapshots it.
      c.render({ nodes: [valve('A', 20)], edges: [] });
      vi.advanceTimersByTime(1000);
      expect(c.sent.autosaves).toHaveLength(1);
      c.hide();
      expect(c.sent.beacons).toHaveLength(2);
      // Nothing new since: nothing sent.
      c.hide(); c.close();
      expect(c.sent.beacons).toHaveLength(2);
    });
  });
});

describe('giving the checkout back', () => {
  it('saves an edit made just before it first, and the autosave after sends nothing more', async () => {
    // A section box let go of, then Release, inside the autosave's second:
    // the save went out after the hold had gone, came back 423, and the edit
    // was only kept as an "(unsaved changes)" copy.
    const c = await open({ nodes: [valve('A', 0)], edges: [] });
    c.render({ nodes: [valve('A', 30)], edges: [] });
    await c.saveNow();
    expect(c.sent.autosaves).toEqual([text({ nodes: [valve('A', 30)], edges: [] })]);
    vi.advanceTimersByTime(1000);
    expect(c.sent.autosaves).toHaveLength(1);
  });

  it('waits for an autosave still on the wire before the hold goes', async () => {
    const c = await open({ nodes: [valve('A', 0)], edges: [] });
    const land = c.holdNextSave();
    c.render({ nodes: [valve('A', 40)], edges: [] });
    vi.advanceTimersByTime(1000);
    let done = false;
    const saving = c.saveNow().then(() => { done = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(done).toBe(false);
    land();
    await saving;
    expect(c.sent.autosaves).toEqual([text({ nodes: [valve('A', 40)], edges: [] })]);
  });

  it('sends nothing for a drawing with nothing unsaved', async () => {
    const c = await open({ nodes: [valve('A', 0)], edges: [] });
    await c.saveNow();
    expect(c.sent.autosaves).toEqual([]);
  });
});
