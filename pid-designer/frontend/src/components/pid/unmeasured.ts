import type { Node } from '@xyflow/react';
import { Position } from '@xyflow/react';
import { J_END, isJunction, junctionEnd } from './junctions';
import type { EndLookup, Face } from './junctions';
import { turnPlacement } from './route';
import type { PIDNodeData } from './types';
import { TANK_H, TANK_W, endPortOffsets } from './nodes/TankNode';
import { manifoldLayout } from './nodes/ManifoldNode';
import { ENGINE_H, ENGINE_INLET_ALONG, ENGINE_W } from './nodes/EngineNode';
import { DW_H, DW_W, KB_H, KB_OUTLET_ALONG, KB_W } from './nodes/SupplyNode';
import { PR_H, PR_W } from './nodes/PRNode';
import type { Side } from './manifoldGeometry';

/**
 * Where a symbol's ports are before React Flow has measured them.
 *
 * The canvas reads every port off React Flow's measured handles, and that is
 * the only answer it trusts. But some things have to place a port with no
 * canvas to ask: opening an old drawing (`migrate`), which puts its tees on
 * their pipes before anything is drawn, and a line that has not drawn yet,
 * whose probe's leader has to land on it (attach.ts). Each works from the
 * layouts the symbols themselves draw from -- the same constants, not
 * copies of them -- so a symbol resized in its component is placed here as
 * it is drawn.
 */

/** The side a named port is on, before its symbol is turned: named for its side, or first letter. */
const SIDE_OF_PORT: Record<string, Position> = { l: Position.Left, r: Position.Right, t: Position.Top, b: Position.Bottom };
const SIDE_OF_LAYOUT: Record<Side, Position> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };

/**
 * Where a symbol draws a port, unturned: the side, how far along it from the
 * box's top-left, and the box. The same layouts the node components draw
 * from -- a tank's lid ports at their grid offsets, a manifold's from its
 * layout, the engine's and the supplies' from their tables -- and, for the
 * rest, the middle of the side the port is named for.
 */
function portLayout(node: Node, handle: string): { side: Position; along: number; w: number; h: number } | null {
  const data = node.data as unknown as PIDNodeData;
  const options = (data?.options ?? {}) as Record<string, unknown>;
  const centred = (side: Position, w: number, h: number) =>
    ({ side, along: side === Position.Top || side === Position.Bottom ? w / 2 : h / 2, w, h });
  switch (data?.componentType) {
    case 'TANK': {
      const m = /^([tb])(\d*)$/.exec(handle);
      if (!m) return null;
      const count = Math.max(1, Math.min(4, Number(options[m[1] === 't' ? 'portsTop' : 'portsBottom'] ?? 1) || 1));
      const offsets = endPortOffsets(count, TANK_W);
      const i = m[2] ? Number(m[2]) - 1 : 0;
      if (i < 0 || i >= offsets.length) return null;
      return { side: m[1] === 't' ? Position.Top : Position.Bottom, along: offsets[i], w: TANK_W, h: TANK_H };
    }
    case 'MANIFOLD': {
      const outlets = Math.max(1, Number(options.outlets ?? 4));
      const layout = manifoldLayout(outlets, options.orientation as string | undefined, data.geometry);
      const port = layout.ports[handle];
      return port ? { side: SIDE_OF_LAYOUT[port.side], along: port.along, w: layout.width, h: layout.height } : null;
    }
    case 'ENGINE':
      if (handle === 'fuel') return { side: Position.Left, along: ENGINE_INLET_ALONG, w: ENGINE_W, h: ENGINE_H };
      if (handle === 'ox') return { side: Position.Right, along: ENGINE_INLET_ALONG, w: ENGINE_W, h: ENGINE_H };
      return handle === 't' ? centred(Position.Top, ENGINE_W, ENGINE_H) : null;
    case 'KBOTTLE':
      if (handle === 'r') return { side: Position.Right, along: KB_OUTLET_ALONG, w: KB_W, h: KB_H };
      return handle === 't' ? centred(Position.Top, KB_W, KB_H) : null;
    case 'DEWAR':
      return handle in SIDE_OF_PORT ? centred(SIDE_OF_PORT[handle], DW_W, DW_H) : null;
    case 'PR':
      if (handle === 'dome') return centred(Position.Top, PR_W, PR_H);
      break;
  }
  const side = SIDE_OF_PORT[handle] ?? SIDE_OF_PORT[handle[0]];
  if (!side) return null;
  // A box nothing lists, unturned: what it measured, turned back.
  const rotation = data?.rotation ?? 0;
  const quarter = Math.round((((rotation % 360) + 360) % 360) / 90) % 2 === 1;
  const mw = node.measured?.width ?? node.width ?? 60, mh = node.measured?.height ?? node.height ?? 60;
  return centred(side, quarter ? mh : mw, quarter ? mw : mh);
}

/**
 * Where a port of a symbol nothing has measured sits: where its symbol
 * draws it (`portLayout`), turned with the symbol, three pixels out where
 * React Flow anchors a line on the handle's outer edge. Near enough to pick
 * which port a line was drawn from and to put an old tee on its pipe; the
 * drawing's own measurement replaces it on the first render.
 */
export const unmeasuredEnd: EndLookup = (node, handle) => {
  if (!handle) return null;
  if (isJunction(node)) return handle in SIDE_OF_PORT ? { ...junctionEnd(node.position, handle as Face), ...J_END } : null;
  const layout = portLayout(node, handle);
  if (!layout) return null;
  const rotation = (node.data as unknown as PIDNodeData)?.rotation ?? 0;
  const turned = turnPlacement(layout.side, layout.along, layout.w, layout.h, rotation);
  const quarter = Math.round((((rotation % 360) + 360) % 360) / 90) % 2 === 1;
  const bw = quarter ? layout.h : layout.w, bh = quarter ? layout.w : layout.h;
  const { x, y } = node.position;
  switch (turned.side) {
    case Position.Left: return { x: x - 3, y: y + turned.along, side: turned.side };
    case Position.Right: return { x: x + bw + 3, y: y + turned.along, side: turned.side };
    case Position.Top: return { x: x + turned.along, y: y - 3, side: turned.side };
    default: return { x: x + turned.along, y: y + bh + 3, side: turned.side };
  }
};
