import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider, applyNodeChanges } from '@xyflow/react';
import type { InternalNode, Node, NodeChange, NodeProps, ReactFlowState } from '@xyflow/react';
import { getNodesInside } from '@xyflow/system';
import { RegionNode, bandOnPartOf, releaseFromBand } from './nodes/RegionNode';

// The app's stylesheet as text. Read from disk because vitest hands a CSS
// import over empty, and by a name this project's types do not know, because
// they are the browser's and not node's.
const fsModule = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as
  { readFileSync(path: URL, encoding: 'utf8'): string };
const stylesheet = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

function markup(): string {
  const props = {
    id: 'R1', type: 'REGION', selected: false, dragging: false, zIndex: -1, isConnectable: false,
    positionAbsoluteX: 0, positionAbsoluteY: 0, width: 320, height: 220,
    data: { componentType: 'REGION', label: 'Section' },
  } as unknown as NodeProps;
  return renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(RegionNode, props)));
}

/** The opening tag of the element whose text is `text`. */
const tagOf = (html: string, text: string) => new RegExp(`<div([^>]*)>${text}</div>`).exec(html)?.[1] ?? '';

describe('a section takes presses only on its title bar', () => {
  it('lets React Flow drag it by the title bar', () => {
    // Marked `nodrag`, the title could not move the box; with the body taking
    // no presses either, nothing could.
    const title = tagOf(markup(), 'Section');
    expect(title).toContain('pointer-events:all');
    expect(title).not.toContain('nodrag');
  });

  it('keeps the title bar above the box, so none of the inside is a handle', () => {
    const title = tagOf(markup(), 'Section');
    const top = Number(/top:(-?[\d.]+)px/.exec(title)?.[1]);
    const height = Number(/line-height:([\d.]+)px/.exec(title)?.[1]);
    expect(top + height).toBeLessThanOrEqual(0);
  });

  it('draws a box that takes no presses', () => {
    const body = /<div style="([^"]*border:[^"]*)"/.exec(markup())?.[1] ?? '';
    expect(body).toContain('pointer-events:none');
  });

  it('overrides the pointer-events React Flow writes on the wrapper, and hands them back to the resize handles', () => {
    // React Flow writes `pointer-events: all` inline on every selectable
    // node's wrapper; only an !important rule takes that back, and
    // pointer-events is inherited, so the resize handles need theirs again.
    const css = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.react-flow__node-REGION\s*\{\s*pointer-events:\s*none\s*!important;\s*\}/);
    expect(css).toMatch(/\.react-flow__node-REGION \.react-flow__resize-control\s*\{\s*pointer-events:\s*all;\s*\}/);
  });
});

describe('a rubber band takes a section only when it encloses the box', () => {
  // A section drawn round two valves, as a stand's bay is.
  const drawing = (): Node[] => [
    { id: 'R1', type: 'REGION', position: { x: 400, y: 60 }, width: 320, height: 220, data: {} },
    { id: 'V5', type: 'VALVE', position: { x: 430, y: 140 }, width: 40, height: 40, data: {} },
    { id: 'V6', type: 'VALVE', position: { x: 630, y: 140 }, width: 40, height: 40, data: {} },
  ];
  type Box = { x: number; y: number; width: number; height: number };
  type State = Pick<ReactFlowState, 'userSelectionRect' | 'userSelectionActive' | 'transform' | 'nodeLookup' | 'triggerNodeChanges'>;

  /**
   * One band, drawn the way React Flow's pane draws it: the rectangle set on
   * pointer-down, then per move its own Partial-mode hit test, a select
   * change for every node whose membership changed (marking the internal
   * node as it goes), and the new rectangle; then cleared on pointer-up.
   * A render between moves copies the app's nodes into the internal ones.
   * `bands` are in flow coordinates and are drawn at `transform`.
   */
  function drawBand(bands: Box[], transform: [number, number, number] = [0, 0, 1], moved = true) {
    let nodes = drawing();
    const lookup = new Map(nodes.map(n => [n.id, {
      ...n, measured: { width: n.width, height: n.height },
      internals: { positionAbsolute: n.position, handleBounds: { source: [], target: [] }, z: 0, userNode: n },
    } as unknown as InternalNode]));
    const render = () => { for (const n of nodes) lookup.get(n.id)!.selected = n.selected; };
    const sent: NodeChange[][] = [];
    const midBand: boolean[] = [];
    let state = {
      userSelectionRect: null, userSelectionActive: false, transform, nodeLookup: lookup,
      triggerNodeChanges: (c: NodeChange[]) => { sent.push(c); nodes = applyNodeChanges(c, nodes); },
    } as unknown as State;
    const listeners = new Set<(s: State, prev: State) => void>();
    const setState = (patch: Partial<State>) => {
      const prev = state;
      state = { ...state, ...patch };
      listeners.forEach(l => l(state, prev));
    };
    const off = releaseFromBand({ subscribe(l) { listeners.add(l); return () => { listeners.delete(l); }; } }, 'R1');

    const [tx, ty, zoom] = transform;
    const onScreen = (b: Box) => ({ x: b.x * zoom + tx, y: b.y * zoom + ty, width: b.width * zoom, height: b.height * zoom });
    const start = onScreen(bands[0]);
    setState({ userSelectionRect: { ...start, width: 0, height: 0, startX: bands[0].x, startY: bands[0].y } });
    let inside = new Set<string>();
    for (const b of moved ? bands : []) {
      const rect = onScreen(b);
      const next = new Set(getNodesInside(lookup, rect, transform, true, true).map(n => n.id));
      if ([...next].join() !== [...inside].join()) {
        const changes: NodeChange[] = [];
        for (const [id, item] of lookup) {
          const will = next.has(id);
          if (!(item.selected === undefined && !will) && item.selected !== will) {
            item.selected = will;
            changes.push({ id, type: 'select', selected: will });
          }
        }
        state.triggerNodeChanges(changes);
      }
      inside = next;
      setState({ userSelectionRect: { ...rect, startX: bands[0].x, startY: bands[0].y }, userSelectionActive: true });
      midBand.push(bandOnPartOf(state, 'R1'));
      render();
    }
    setState({ userSelectionActive: false, userSelectionRect: null });
    const internal = [...lookup.values()].filter(n => n.selected).map(n => n.id);
    render();
    off();
    return { selected: nodes.filter(n => n.selected).map(n => n.id), internal, sent, midBand };
  }

  it('takes the parts and not the section when the band is drawn among them', () => {
    // The press lands on empty canvas inside the box, which is where a band
    // round two of its valves has to start.
    const band = drawBand([{ x: 420, y: 120, width: 100, height: 40 }, { x: 420, y: 120, width: 290, height: 100 }]);
    expect(band.selected).toEqual(['V5', 'V6']);
    // Let go in React Flow's own copy too, which is what a drag of the
    // selection moves before the app's copy has rendered.
    expect(band.internal).toEqual(['V5', 'V6']);
  });

  it('takes the section with its parts when the band encloses the box', () => {
    const band = drawBand([{ x: 380, y: 40, width: 100, height: 100 }, { x: 380, y: 40, width: 360, height: 260 }]);
    expect(band.selected).toEqual(['R1', 'V5', 'V6']);
  });

  it('leaves the section when a band from outside crosses part of it', () => {
    const band = drawBand([{ x: 300, y: 100, width: 200, height: 150 }]);
    expect(band.selected).toEqual(['V5']);
  });

  it('measures the band where it is drawn, at any zoom and pan', () => {
    const at: [number, number, number] = [-150, 40, 1.5];
    expect(drawBand([{ x: 420, y: 120, width: 290, height: 100 }], at).selected).toEqual(['V5', 'V6']);
    expect(drawBand([{ x: 380, y: 40, width: 360, height: 260 }], at).selected).toEqual(['R1', 'V5', 'V6']);
  });

  it('hides the resize handles while the band covers only part of the box', () => {
    const band = drawBand([
      { x: 420, y: 120, width: 290, height: 100 },
      { x: 380, y: 40, width: 360, height: 260 },
    ]);
    expect(band.midBand).toEqual([true, false]);
  });

  it('changes nothing for a click that never became a band', () => {
    const band = drawBand([{ x: 420, y: 120, width: 0, height: 0 }], [0, 0, 1], false);
    expect(band.sent).toEqual([]);
  });
});
