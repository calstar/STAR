// What the canvas's keys and page controls act on.
//
// The pure pieces -- turnSelected, copySelection's page, clearSelection,
// selectOnPage, pasteClip's id check -- have their own tests. What those
// cannot catch is the canvas forgetting to use them: an R handler that goes
// back to turning every selected symbol, a Cmd+D that copies without a page,
// a page tab that switches without clearing. The canvas cannot be mounted
// here (it needs React Flow's store and a DOM), so each handler is cut out of
// PIDDesigner.tsx as written, compiled, and run against the real helpers over
// a stand-in window -- in the spirit of lib/gating.test.ts, which audits the
// same file's source. If a handler is renamed or moved, `cut` says which one.
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import type { Edge, Node } from '@xyflow/react';
import { runChecks } from './checks';
import { copySelection, pasteClip } from './clipboard';
import { turnSelected } from './graphOps';
import { clearSelection, pageOf, pageOfSubjects, selectOnPage } from './pages';
import { canvasProp, canvasStatement, canvasStatements } from './canvasSource';

const js = (tsx: string) => ts.transpileModule(tsx, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
/**
 * The arrow function a JSX prop is set to, from the text that opens it (the
 * prop and the arrow's parameters), as a function of the names it closes over.
 */
function propHandler(opening: string, names: string[]) {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...names, `return ${js(canvasProp(opening))}`);
}

type G = { nodes: Node[]; edges: Edge[] };
const valve = (id: string, page: string, selected = false, x = 100): Node =>
  ({ id, type: 'MAN', position: { x, y: 100 }, selected, measured: { width: 60, height: 60 },
     data: { componentType: 'MAN', label: id, page, rotation: 0 } }) as Node;
const line = (s: string, t: string, selected = false): Edge =>
  ({ id: `${s}-${t}`, source: s, target: t, sourceHandle: 'r', targetHandle: 'l', selected, data: {} });
/** Main and GSE, each with a pair of valves and a line, and a selection left on both. */
const drawing = (): G => ({
  nodes: [valve('V1', 'Main', true), valve('V2', 'Main', true, 300), valve('G1', 'GSE', true), valve('G2', 'GSE', false, 300)],
  edges: [line('V1', 'V2', true), line('G1', 'G2', true)],
});
const selectedIds = (xs: { id: string; selected?: boolean }[]) => xs.filter(x => x.selected).map(x => x.id);
const rotation = (n: Node) => (n.data as { rotation?: number }).rotation;

/** A canvas reduced to state and setters, as the handlers see it. */
function canvas(g: G, page: string) {
  const s = { ...g, page, declared: [] as string[] };
  const apply = <T,>(cur: T, f: T | ((x: T) => T)) => (typeof f === 'function' ? (f as (x: T) => T)(cur) : f);
  return {
    s,
    pageRef: { get current() { return s.page; } },
    snapshot: { get current() { return { nodes: s.nodes, edges: s.edges }; } },
    setNodes: (f: Node[] | ((n: Node[]) => Node[])) => { s.nodes = apply(s.nodes, f); },
    setEdges: (f: Edge[] | ((e: Edge[]) => Edge[])) => { s.edges = apply(s.edges, f); },
    setPage: (f: string | ((p: string) => string)) => { s.page = apply(s.page, f); },
    setDeclaredPages: (f: string[] | ((p: string[]) => string[])) => { s.declared = apply(s.declared, f); },
    commitGraph: (nodes: Node[], edges: Edge[]) => { s.nodes = nodes; s.edges = edges; },
  };
}

/** Mount one of the canvas's keydown effects on a stand-in window; returns a key presser. */
function mountKeys(effect: string, names: string[], values: unknown[], focused: unknown = null) {
  let handler: ((e: KeyboardEvent) => void) | null = null;
  const win = { addEventListener: (_: string, h: (e: KeyboardEvent) => void) => { handler = h; }, removeEventListener() {} };
  const doc = { activeElement: focused };
  const useRef = <T,>(v: T) => ({ current: v });
  const useEffect = (f: () => void) => { f(); };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('useRef', 'useEffect', 'window', 'document', ...names, js(effect))(
    useRef, useEffect, win, doc, ...values);
  return (key: string, mods: { meta?: boolean } = {}) => handler!({
    key, metaKey: !!mods.meta, ctrlKey: false, altKey: false, shiftKey: false, preventDefault() {},
  } as unknown as KeyboardEvent);
}

function clipboardKeys(c: ReturnType<typeof canvas>, drawn = new Map<string, { x: number; y: number }[]>()) {
  return mountKeys(
    canvasStatements('const clipRef = useRef', 'useEffect(() => {\n    const typing = () => {'),
    ['snapshot', 'readOnlyRef', 'pageRef', 'commitGraph', 'setNodes', 'copySelection', 'pasteClip', 'pageOf', 'drawnCorners',
      'endOfClear'],
    [c.snapshot, { current: false }, c.pageRef, c.commitGraph, c.setNodes, copySelection, pasteClip, pageOf, () => drawn,
      () => null],
  );
}
function rKey(c: ReturnType<typeof canvas>, focused: unknown = null) {
  return mountKeys(
    canvasStatement('// R turns what is selected'),
    ['readOnlyRef', 'pageRef', 'setNodes', 'turnSelected'],
    [{ current: false }, c.pageRef, c.setNodes, turnSelected],
    focused,
  );
}

describe('the keys act on the page in view', () => {
  it('R turns what is selected here and nothing left selected on another page', () => {
    const c = canvas(drawing(), 'GSE');
    rKey(c)('r');
    expect(c.s.nodes.filter(n => rotation(n) === 90).map(n => n.id)).toEqual(['G1']);
  });

  it('R typed into a field is a letter, not a turn', () => {
    const c = canvas(drawing(), 'GSE');
    rKey(c, { tagName: 'INPUT', isContentEditable: false })('r');
    expect(c.s.nodes.some(n => rotation(n) === 90)).toBe(false);
  });

  it('Cmd+D duplicates what is selected here, onto here', () => {
    const c = canvas(drawing(), 'GSE');
    clipboardKeys(c)('d', { meta: true });
    const added = c.s.nodes.slice(4);
    expect(added).toHaveLength(1);
    expect(added.map(n => (n.data as { label: string }).label)).toEqual(['G1-1']);
    expect(added.every(n => pageOf(n.data as { page?: string }) === 'GSE')).toBe(true);
  });

  it('Cmd+C copies what is selected here, so Cmd+V pastes only that', () => {
    const c = canvas(drawing(), 'Main');
    const press = clipboardKeys(c);
    press('c', { meta: true });
    press('v', { meta: true });
    const added = c.s.nodes.slice(4);
    expect(added.map(n => (n.data as { label: string }).label)).toEqual(['V1-1', 'V2-1']);
    // The line between the two copied valves comes along; GSE's does not.
    expect(c.s.edges.slice(2).map(e => [e.source, e.target])).toEqual([[added[0].id, added[1].id]]);
  });

  it('Cmd+V never names a line after one already on the drawing', () => {
    // Node ids come from a counter; put a line on the drawing under the name
    // the paste's line would naturally get.
    const c = canvas(drawing(), 'Main');
    const probe = pasteClip(copySelection(c.s.nodes, c.s.edges, 'Main')!, c.s.nodes, 'Main');
    const next = (id: string) => id.replace(/\d+$/, m => String(Number(m) + 2));
    const natural = `${next(probe.edges[0].source)}-${next(probe.edges[0].target)}`;
    c.s.edges = [...c.s.edges, { ...line('V1', 'V2'), id: natural }];
    const press = clipboardKeys(c);
    press('c', { meta: true });
    press('v', { meta: true });
    const ids = c.s.edges.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the clipboard keys and the lines on the page', () => {
  it('Cmd+V lands a copy clear of the lines drawn on the page, not only of the symbols', () => {
    // V1 -> V2 on Main, copied: beside it, one copy's width along, a line
    // on nothing the canvas has drawn runs down through where the copy's
    // line would go. The canvas tells the paste of the lines as drawn.
    const c = canvas(drawing(), 'Main');
    const drawn = new Map([['V1-V2', [{ x: 160, y: 130 }, { x: 300, y: 130 }]], ['X', [{ x: 500, y: -50 }, { x: 500, y: 250 }]]]);
    const press = clipboardKeys(c, drawn);
    press('c', { meta: true });
    press('v', { meta: true });
    expect(c.s.nodes.slice(4).map(n => n.position)).toEqual([{ x: 700, y: 100 }, { x: 900, y: 100 }]);
  });
});

describe('the clipboard keys and what a copy leaves behind', () => {
  it('Cmd+C heals a tee whose branch stays behind, with its probe where it was on the pipe', () => {
    // V1 -> tee -> V2 along y = 130, the tee's branch up to G, and a probe
    // clipped a quarter of the way along V1's line. G is not copied.
    const tee = { id: 'junc_1', type: 'JUNCTION', position: { x: 225, y: 125 }, selected: true,
      data: { componentType: 'JUNCTION', label: 'junc_1', page: 'Main', along: { t: 0.5, in: 'l', out: 'r', from: 'V1', to: 'V2' } } } as Node;
    const probe = { id: 'PT1', type: 'PT', position: { x: 170, y: 60 }, selected: true,
      data: { componentType: 'PT', label: 'PT-1', page: 'Main', attachedTo: 'V1-junc_1', attachedAt: 0.25 } } as Node;
    const g: G = {
      nodes: [valve('V1', 'Main', true), valve('V2', 'Main', true, 400), valve('G', 'Main', false, 200), tee, probe],
      edges: [line('V1', 'junc_1'), line('junc_1', 'V2'), { ...line('junc_1', 'G'), sourceHandle: 't', targetHandle: 'b' }],
    };
    const c = canvas(g, 'Main');
    const drawn = new Map([
      ['V1-junc_1', [{ x: 160, y: 130 }, { x: 222, y: 130 }]],
      ['junc_1-V2', [{ x: 238, y: 130 }, { x: 400, y: 130 }]],
    ]);
    const press = clipboardKeys(c, drawn);
    press('c', { meta: true });
    press('v', { meta: true });
    const added = c.s.nodes.slice(5);
    expect(added.some(n => n.type === 'JUNCTION')).toBe(false);
    const healed = c.s.edges.slice(3);
    expect(healed).toHaveLength(1);
    const clip = added.find(n => (n.data as { componentType?: string }).componentType === 'PT')!.data as
      { attachedTo?: string; attachedAt?: number };
    expect(clip.attachedTo).toBe(healed[0].id);
    // 15.5 px along a healed run 240 long.
    expect(clip.attachedAt).toBeCloseTo(15.5 / 240, 9);
  });
});

describe('changing page', () => {
  const tabs = (c: ReturnType<typeof canvas>) => ({
    select: propHandler('onSelect={(p) => {', ['setNodes', 'setEdges', 'setPage', 'pageRef', 'clearSelection'])(
      c.setNodes, c.setEdges, c.setPage, c.pageRef, clearSelection) as (p: string) => void,
    add: propHandler('onAdd={(name) => {', ['setDeclaredPages', 'setNodes', 'setEdges', 'setPage', 'clearSelection'])(
      c.setDeclaredPages, c.setNodes, c.setEdges, c.setPage, clearSelection) as (p: string) => void,
  });

  /** The checks panel's onSelect, framing into `framed` and remembering views in `viewports`. */
  const checksPanel = (c: ReturnType<typeof canvas>, viewports: Map<string, unknown>, framed: string[]) =>
    propHandler('onSelect={(nodeIds, edgeIds) => {', [
      'nodes', 'edges', 'pageRef', 'setNodes', 'setEdges', 'setPage', 'pageOf', 'pageOfSubjects', 'selectOnPage',
      'viewportsRef', 'diagramKey', 'fitViewTo',
    ])(c.s.nodes, c.s.edges, c.pageRef, c.setNodes, c.setEdges, c.setPage, pageOf, pageOfSubjects, selectOnPage,
      { current: viewports }, 'd', (n: Node) => { framed.push(n.id); }) as (nodeIds: string[], edgeIds: string[]) => void;

  it('a tab leaves nothing selected behind', () => {
    const c = canvas(drawing(), 'Main');
    tabs(c).select('GSE');
    expect(c.s.page).toBe('GSE');
    expect(selectedIds(c.s.nodes)).toEqual([]);
    expect(selectedIds(c.s.edges)).toEqual([]);
  });

  it('the tab already open keeps its selection', () => {
    const c = canvas(drawing(), 'Main');
    tabs(c).select('Main');
    expect(selectedIds(c.s.nodes)).toEqual(['V1', 'V2', 'G1']);
  });

  it('a new page is somewhere else too', () => {
    const c = canvas(drawing(), 'Main');
    tabs(c).add('Vent');
    expect(c.s.page).toBe('Vent');
    expect(c.s.declared).toEqual(['Vent']);
    expect(selectedIds(c.s.nodes)).toEqual([]);
  });

  it('picking a check goes to the page of what it names, and selects only that', () => {
    const c = canvas(drawing(), 'Main');
    const viewports = new Map([['d::GSE', { x: 1, y: 2, zoom: 3 }], ['d::Main', { x: 0, y: 0, zoom: 1 }]]);
    const framed: string[] = [];
    const checks = checksPanel(c, viewports, framed);
    checks(['G2', 'V1'], ['G1-G2']);
    expect(c.s.page).toBe('GSE');
    expect(selectedIds(c.s.nodes)).toEqual(['G2']);
    expect(selectedIds(c.s.edges)).toEqual(['G1-G2']);
    // Arriving frames the page afresh rather than restoring a view that may
    // not show what was picked.
    expect(viewports.has('d::GSE')).toBe(false);
    expect(framed).toEqual([]);
  });

  it('picking a check on the page in view frames what it names there', () => {
    const c = canvas(drawing(), 'GSE');
    const framed: string[] = [];
    const checks = checksPanel(c, new Map(), framed);
    checks(['G2'], []);
    expect(c.s.page).toBe('GSE');
    expect(selectedIds(c.s.nodes)).toEqual(['G2']);
    expect(framed).toEqual(['G2']);
  });

  it('frames what a check names on the page in view, not its mate drawn earlier on another', () => {
    // V1 comes before G2 in the drawing and is on Main: centring on it
    // from GSE would show an empty stretch of GSE.
    const c = canvas(drawing(), 'GSE');
    const framed: string[] = [];
    checksPanel(c, new Map(), framed)(['G2', 'V1'], []);
    expect(c.s.page).toBe('GSE');
    expect(selectedIds(c.s.nodes)).toEqual(['G2']);
    expect(framed).toEqual(['G2']);
  });

  // The checks about lines that no page draws, picked as the panel picks
  // them: with the ids the real checks give them.
  const withUndrawnLines = (): G => {
    const g = drawing();
    return {
      nodes: clearSelection(g.nodes),
      edges: [...clearSelection(g.edges), line('V2', 'G1'), line('G2', 'gone')],
    };
  };
  const check = (g: G, id: string) => {
    const f = runChecks(g.nodes, g.edges).find(x => x.id === id);
    if (!f) throw new Error(`no ${id} check on this drawing`);
    return [f.nodeIds ?? [], f.edgeIds ?? []] as const;
  };

  it('picking the check about a line between pages selects the component it leaves from', () => {
    const c = canvas(withUndrawnLines(), 'GSE');
    const viewports = new Map([['d::Main', { x: 1, y: 2, zoom: 3 }]]);
    const framed: string[] = [];
    checksPanel(c, viewports, framed)(...check(c.s, 'lines-cross-pages'));
    expect(c.s.page).toBe('Main');
    expect(selectedIds(c.s.nodes)).toEqual(['V2']);
    expect(selectedIds(c.s.edges)).toEqual([]);
    expect(viewports.has('d::Main')).toBe(false);
  });

  it('picking the check about a line that hangs off nothing selects, and frames, what it still hangs off', () => {
    const c = canvas(withUndrawnLines(), 'GSE');
    const framed: string[] = [];
    checksPanel(c, new Map(), framed)(...check(c.s, 'line-dangling-G2-gone'));
    expect(c.s.page).toBe('GSE');
    expect(selectedIds(c.s.nodes)).toEqual(['G2']);
    expect(framed).toEqual(['G2']);
  });
});
