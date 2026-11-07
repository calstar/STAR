// What a drawing is written as -- to the server, and to the JSON a person
// exports -- is its authored content, never React Flow's view of it.
import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { drawingJSON, toStored } from '../../api/diagrams';

// A node and a line as the canvas holds them after the GSE page was opened
// and a dialog used: measured, selected, and marked hidden because they are
// on the Rocket page. LE4 (3)'s export carried all of it.
const viewed = () => ({
  nodes: [
    { id: 'node_22', type: 'TANK', position: { x: 10, y: 20 }, data: { componentType: 'TANK', page: 'Rocket' },
      measured: { width: 60, height: 100 }, selected: true, dragging: false, hidden: true },
    { id: 'node_45', type: 'REGION', position: { x: 80, y: 140 }, width: 690, height: 1410, zIndex: -1,
      resizing: false, hidden: false, data: { componentType: 'REGION', page: 'Rocket' } },
  ] as unknown as Node[],
  edges: [
    { id: 'a-b', source: 'a', target: 'b', data: {}, selected: false, hidden: true, reconnectable: 'target' },
  ] as unknown as Edge[],
});

describe('a drawing as stored', () => {
  it('leaves out which page the canvas is showing, and a resize in progress', () => {
    // pages.ts: the drawing never stores `hidden`; the page a symbol is on is
    // `data.page`, and what is hidden is worked out afresh for each view.
    const { nodes, edges } = toStored(viewed());
    for (const n of nodes) {
      expect(n).not.toHaveProperty('hidden');
      expect(n).not.toHaveProperty('resizing');
      expect(n).not.toHaveProperty('selected');
      expect(n).not.toHaveProperty('measured');
    }
    expect(edges[0]).not.toHaveProperty('hidden');
  });

  it('keeps a section\'s size, which somebody drew', () => {
    const region = toStored(viewed()).nodes[1];
    expect(region).toMatchObject({ width: 690, height: 1410, zIndex: -1 });
  });
});

describe('a drawing exported as JSON', () => {
  it('is the drawing as stored, not the canvas\'s view of it', () => {
    const out = JSON.parse(drawingJSON(viewed()));
    expect(out).toEqual(JSON.parse(JSON.stringify(toStored(viewed()))));
    expect(JSON.stringify(out)).not.toMatch(/"(measured|selected|hidden|resizing|dragging)"/);
  });
});
