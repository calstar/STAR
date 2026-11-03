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
    'lastSaved', 'diagramKey', 'landOnPage', 'serverHas', 'setOpened']);
const autosaveEffect = compiled(canvasStatement('// Debounced autosave of the working copy'),
  ['useEffect', 'loadedId', 'diagramKey', 'readOnlyRef', 'api', 'nodes', 'edges', 'lastSaved', 'unsnapped',
    'diagramRef', 'onForbidden', 'onLockLost', 'inFlight', 'heldRef', 'firstEdit', 'serverHas', 'dropUnsent']);
const flushEffect = compiled(canvasStatement('// Best-effort flush to S3 on tab close / hide'),
  ['useEffect', 'loadedId', 'diagramKey', 'readOnlyRef', 'api', 'snapshot', 'lastSaved', 'unsnapped', 'diagramRef',
    'window', 'document', 'heldRef', 'serverHas', 'claiming', 'keepUnsent']);
const saveNowStatement = compiled(canvasStatement('// Giving the checkout back has to wait for this.'),
  ['useCallback', 'saveNowRef', 'inFlight', 'loadedId', 'diagramKey', 'readOnlyRef', 'snapshot', 'api', 'lastSaved',
    'unsnapped', 'diagramRef', 'serverHas']);
const firstEditStatement = compiled(canvasStatement('const firstEdit = useCallback('),
  ['useCallback', 'heldRef', 'claim', 'claiming', 'api', 'diagramRef', 'onLockLost', 'serverHas', 'onStale'], 'firstEdit');

/**
 * How the checkout stands when the drawing is opened: held (the old way, and
 * deployed after Take), or not yet -- a developer's own machine, where the
 * first edit takes it -- and what taking it then finds.
 */
interface Opening {
  held?: boolean;
  /** What `claim` answers: whether the take succeeded. */
  takes?: boolean;
  /** What the server holds by the time of the first edit, if somebody saved over it. */
  savedOver?: G;
}

/** The canvas's state and refs, and a server that records what it is sent. */
async function open(stored: G, opening: Opening = {}) {
  const { held = true, takes = true, savedOver } = opening;
  const refs = {
    loadedId: { current: null as string | null }, lastSaved: { current: '' }, unsnapped: { current: false },
    inFlight: { current: null as Promise<unknown> | null },
    heldRef: { current: held }, serverHas: { current: '' }, claiming: { current: null as Promise<boolean> | null },
  };
  const told = {
    claims: 0, lost: [] as (string | undefined)[], stale: [] as (string | undefined)[], rescued: [] as string[],
    // Kept on this machine on tab close (`unsentEdit`), and let go of once sent.
    kept: [] as string[], dropped: [] as (string | undefined)[],
  };
  let loads = 0;
  let g: G = { nodes: [], edges: [] };
  const sent = { autosaves: [] as string[], beacons: [] as string[], stringified: 0 };
  /** Set, and the next autosave is held on the wire until it is called. */
  let hold: { release?: () => void } | null = null;
  const server = {
    ...api,
    // The first load is the opening; any after it is the first edit asking
    // what the server has now.
    loadDiagram: () => Promise.resolve(structuredClone(loads++ === 0 || !savedOver ? stored : savedOver)),
    rescueDiagram: (_: unknown, x: G) => { told.rescued.push(text(x)); return Promise.resolve({ name: 'LE4 Stand (unsaved changes)' }); },
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
    (e: Edge[]) => { g = { ...g, edges: e }; }, () => {}, refs.lastSaved, 'd', () => {}, refs.serverHas, () => {});
  await Promise.resolve(); await Promise.resolve();
  // The flush effect, registered once, and its listeners.
  const heard: Record<string, () => void> = {};
  const target = { addEventListener: (k: string, f: () => void) => { heard[k] = f; }, removeEventListener: () => {} };
  const doc = { ...target, visibilityState: 'hidden' };
  flushEffect(run, refs.loadedId, 'd', { current: false }, server, { get current() { return g; } }, refs.lastSaved,
    refs.unsnapped, { id: 'd' }, target, doc, refs.heldRef, refs.serverHas, refs.claiming,
    (_key: string, e: { doc: G }) => { told.kept.push(text(e.doc)); });
  // The checkout's take, for the first edit: it holds the diagram from then on.
  const claim = () => { told.claims++; if (takes) refs.heldRef.current = true; return Promise.resolve(takes); };
  const firstEdit = firstEditStatement(<T>(f: T) => f, refs.heldRef, claim, refs.claiming, server, { id: 'd' },
    (name?: string) => { told.lost.push(name); }, refs.serverHas, (name?: string) => { told.stale.push(name); });
  /** A render: the drawing as it now is, handed to the autosave effect; its cleanup, the next render's. */
  let cleanup: (() => void) | void;
  const render = (next: G) => {
    g = next;
    if (typeof cleanup === 'function') cleanup();
    cleanup = undefined;
    autosaveEffect((f: () => void | (() => void)) => { cleanup = f(); }, refs.loadedId, 'd', { current: false }, server,
      g.nodes, g.edges, refs.lastSaved, refs.unsnapped, { id: 'd' }, () => {}, () => {}, refs.inFlight,
      refs.heldRef, firstEdit, refs.serverHas, (_key: string, sent?: string) => { told.dropped.push(sent); });
  };
  // What the checkout's Release awaits before giving the hold back.
  const saveNowRef = { current: (): Promise<void> => Promise.resolve() };
  saveNowStatement(<T>(f: T) => f, saveNowRef, refs.inFlight, refs.loadedId, 'd', { current: false },
    { get current() { return g; } }, server, refs.lastSaved, refs.unsnapped, { id: 'd' }, refs.serverHas);
  const holdNextSave = () => { const h: { release?: () => void } = {}; hold = h; return () => h.release!(); };
  return {
    get: () => g, render, hide: () => heard.visibilitychange(), close: () => heard.pagehide(), sent, refs,
    saveNow: () => saveNowRef.current(), holdNextSave, told,
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

/**
 * On a developer's own machine nothing is taken by opening a diagram; the
 * first edit takes it (`useCheckout`'s `takeOnEdit`). Opening used to take
 * it, and "Editing · 14:52" counted down over every diagram looked at.
 */
describe('the first edit takes the checkout', () => {
  /** Let the claim, the check and the save that follow the timer settle. */
  const settle = async () => { for (let k = 0; k < 8; k++) await Promise.resolve(); };

  it('takes it, then saves the edit', async () => {
    const c = await open({ nodes: [valve('A', 0)], edges: [] }, { held: false });
    c.render({ nodes: [valve('A', 10)], edges: [] });
    vi.advanceTimersByTime(1000);
    expect(c.sent.autosaves).toEqual([]);          // not before it is ours
    await settle();
    expect(c.told.claims).toBe(1);
    expect(c.sent.autosaves).toEqual([text({ nodes: [valve('A', 10)], edges: [] })]);
    // Held now: the next edit is saved straight away, with no second take.
    c.render({ nodes: [valve('A', 20)], edges: [] });
    vi.advanceTimersByTime(1000);
    expect(c.sent.autosaves).toHaveLength(2);
    expect(c.told.claims).toBe(1);
  });

  it('opening and looking takes nothing and sends nothing', async () => {
    const c = await open({ nodes: [valve('A', 0)], edges: [] }, { held: false });
    c.render({ nodes: [{ ...c.get().nodes[0], selected: true }], edges: [] });
    vi.advanceTimersByTime(1000);
    await settle();
    c.hide(); c.close();
    expect(c.told.claims).toBe(0);
    expect(c.sent.autosaves).toEqual([]);
    expect(c.sent.beacons).toEqual([]);
    expect(c.told.kept).toEqual([]);
  });

  it('keeps an edit the tab closes on before it is taken, and lets it go once sent', async () => {
    // Nothing is held until the debounced autosave takes it, and a beacon would
    // only be refused: the edit made in that second was lost with the tab.
    const c = await open({ nodes: [valve('A', 0)], edges: [] }, { held: false });
    c.render({ nodes: [valve('A', 10)], edges: [] });
    c.close();
    expect(c.sent.beacons).toEqual([]);
    expect(c.told.kept).toEqual([text({ nodes: [valve('A', 10)], edges: [] })]);
    // The tab stayed after all (hidden, say): the autosave takes it and sends it.
    vi.advanceTimersByTime(1000);
    await settle();
    expect(c.sent.autosaves).toEqual([text({ nodes: [valve('A', 10)], edges: [] })]);
    expect(c.told.dropped).toEqual([text({ nodes: [valve('A', 10)], edges: [] })]);
  });

  it('keeps the edit as a copy and writes nothing when someone else has the diagram', async () => {
    const c = await open({ nodes: [valve('A', 0)], edges: [] }, { held: false, takes: false });
    c.render({ nodes: [valve('A', 10)], edges: [] });
    vi.advanceTimersByTime(1000);
    await settle();
    expect(c.sent.autosaves).toEqual([]);
    expect(c.told.rescued).toEqual([text({ nodes: [valve('A', 10)], edges: [] })]);
    expect(c.told.lost).toEqual(['LE4 Stand (unsaved changes)']);
  });

  it('never writes an edit over a drawing somebody saved after it was opened', async () => {
    // Taken -- but drawn on the copy as opened, and the server's has moved on.
    const c = await open({ nodes: [valve('A', 0)], edges: [] },
      { held: false, savedOver: { nodes: [valve('A', 0), valve('B', 90)], edges: [] } });
    c.render({ nodes: [valve('A', 10)], edges: [] });
    vi.advanceTimersByTime(1000);
    await settle();
    expect(c.sent.autosaves).toEqual([]);
    expect(c.told.rescued).toEqual([text({ nodes: [valve('A', 10)], edges: [] })]);
    expect(c.told.stale).toEqual(['LE4 Stand (unsaved changes)']);
  });

  it('takes it once for several edits made while it is being taken', async () => {
    const c = await open({ nodes: [valve('A', 0)], edges: [] }, { held: false });
    c.render({ nodes: [valve('A', 10)], edges: [] });
    vi.advanceTimersByTime(1000);
    c.render({ nodes: [valve('A', 20)], edges: [] });
    vi.advanceTimersByTime(1000);
    await settle();
    expect(c.told.claims).toBe(1);
    expect(c.sent.autosaves.at(-1)).toBe(text({ nodes: [valve('A', 20)], edges: [] }));
  });
});
