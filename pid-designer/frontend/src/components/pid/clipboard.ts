/**
 * Copy, paste and duplicate.
 *
 * A stand has eight solenoid valves that are the same solenoid valve, and a
 * drawing tool with no way to copy one is a drawing tool where the eighth is
 * configured by hand from the palette like the first. This is the model
 * underneath Cmd+C / Cmd+V / Cmd+D: what a copy holds, and how it lands.
 *
 * What lands is a *new* symbol, not a reference. Fresh ids, because an id is
 * the tag a solver keys on; a fresh tag from the same template, because two
 * valves both called SOL-3 is exactly the duplicate the checks exist to
 * catch; and only the lines whose both ends were copied, because half a
 * pipe is worse than none. A probe clipped to a copied component or line
 * stays clipped to the copy; one clipped to something outside the selection
 * is pasted loose, since what it measured did not come along.
 *
 * And what lands is the original *moved*, all of it. A line's corners and a
 * tee's record of its pipe are stored in absolute coordinates, so a paste
 * that moved only the symbols left every hand-routed line in the copy running
 * back to the original's corners, and a copied tee seated itself on the
 * original's pipe. The copy goes through the same translate a group drag
 * does -- see graphOps.ts.
 */

import type { Edge, Node } from '@xyflow/react';
import { translateSubgraph } from './graphOps';
import { freshEdgeId, nextJunctionId, nextNodeId } from './ids';
import { J_HALF, centreOfJunction, isJunction } from './junctions';
import type { EndLookup } from './junctions';
import { drawnRoute } from './lineRoute';
import { pageOf } from './pages';
import { obstacleBoxes } from './routeGrid';
import type { Box, Pt } from './route';
import { dissolveAfterDelete } from './splitEdge';
import type { HealDrawn } from './splitEdge';
import { numberTag, tagStem } from './tags';
import type { PIDNodeData } from './types';

export interface Clip {
  nodes: Node[];
  edges: Edge[];
}

/** How far a paste lands from the original: enough to see it is a copy. */
export const PASTE_OFFSET = { x: 40, y: 40 };

const dataOf = (n: Node) => n.data as unknown as PIDNodeData;

/**
 * The selected symbols, and the lines that run between them.
 *
 * With a `page`, only what is selected on that page: a selection left on a
 * page the reader has since switched away from is not something they can see
 * they are copying, and Cmd+D used to paste it onto the page in front of them.
 *
 * What the copy leaves behind is to it what a delete is to a drawing, and it
 * is tidied the same way (`dissolveAfterDelete`): a tee on a pipe whose
 * branch went somewhere the selection did not reach is, in the copy, a
 * point on a line with nothing branching off it -- a filled dot in the
 * middle of a straight run, which says the pipe branches there -- and is
 * healed out of it, its two lines one, when they agree about what kind of
 * pipe they are; a junction all of whose lines were left behind is left
 * behind too. A tee somebody put on a run and never branched is copied as it
 * is: it lost nothing. `drawn` gives the lines as they are drawn, so a probe
 * on a healed pair stays where on the pipe it was.
 */
export function copySelection(nodes: Node[], edges: Edge[], page?: string, drawn?: HealDrawn): Clip | null {
  const picked = nodes.filter(n =>
    n.selected && (page === undefined || pageOf(n.data as unknown as PIDNodeData) === page));
  if (picked.length === 0) return null;
  const ids = new Set(picked.map(n => n.id));
  const kept = edges.filter(e => ids.has(e.source) && ids.has(e.target));
  const left = edges.filter(e => ids.has(e.source) !== ids.has(e.target));
  const copy = dissolveAfterDelete([], left, picked, kept, drawn);
  return {
    nodes: structuredClone(copy.nodes.map(({ selected: _s, dragging: _d, measured: _m, ...n }) => n as Node)),
    edges: structuredClone(copy.edges.map(({ selected: _s, ...e }) => e as Edge)),
  };
}

/**
 * What a paste can see of the drawing besides its symbols: its lines as they
 * are drawn, and where the ports are.
 */
export interface PasteGeometry {
  /** The lines on the page as they are drawn, by id (`edgeGeometry.drawnCorners`). */
  drawn: ReadonlyMap<string, Pt[]>;
  /**
   * Where a node's ports are, as the designer measures them: to draw a
   * copied line whose original is not drawn as it was copied -- a line the
   * copy healed, say, or one whose original has moved since.
   */
  endOf?: EndLookup;
}

/**
 * Where a paste lands when nothing says otherwise: for a group, beside the
 * original (`besideOffset`); otherwise PASTE_OFFSET from the original, or as
 * many PASTE_OFFSETs further on as it takes for nothing in the copy to land
 * on a symbol already on `page`.
 *
 * Read off the drawing rather than counted from the keys. A count of Cmd+V
 * presses since the last Cmd+C missed everything else that leaves a copy one
 * offset along -- a Cmd+D put one there without moving the count, so Cmd+C,
 * Cmd+D, Cmd+V pasted exactly onto the duplicate -- and an undone paste never
 * wound the count back, so the next paste skipped a step. The drawing knows
 * where the copies are. Consecutive pastes still step down the page one
 * offset at a time, because each copy is standing on the spot the next one
 * would have taken.
 *
 * "On" means on the same whole pixel, which is what stacked copies are; a
 * symbol dragged a pixel off a copy is somewhere else. It always finds a
 * spot: each symbol on the page can block at most one step for each symbol in
 * the copy, since no two steps put a copied symbol in the same place.
 */
export function pasteOffset(clip: Clip, existing: Node[], page: string, geometry?: PasteGeometry): Pt {
  const beside = besideOffset(clip, existing, page, geometry);
  if (beside) return beside;
  const spot = (x: number, y: number) => `${Math.round(x)},${Math.round(y)}`;
  const taken = new Set(existing
    .filter(n => pageOf(dataOf(n)) === page)
    .map(n => spot(n.position.x, n.position.y)));
  for (let k = 1; ; k++) {
    const d = { x: PASTE_OFFSET.x * k, y: PASTE_OFFSET.y * k };
    if (!clip.nodes.some(n => taken.has(spot(n.position.x + d.x, n.position.y + d.y)))) return d;
  }
}

/** Something drawn, as the rectangle it covers: a symbol, a tee's dot, or one straight piece of a line. */
interface Rect { x0: number; y0: number; x1: number; y1: number }

const rectOfBox = (b: Box): Rect => ({ x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h });
const rectOfDot = (n: Node): Rect => {
  const c = centreOfJunction(n);
  return { x0: c.x - J_HALF, y0: c.y - J_HALF, x1: c.x + J_HALF, y1: c.y + J_HALF };
};
const rectsOfLine = (pts: Pt[]): Rect[] => pts.slice(1).map((q, i) => ({
  x0: Math.min(pts[i].x, q.x), y0: Math.min(pts[i].y, q.y), x1: Math.max(pts[i].x, q.x), y1: Math.max(pts[i].y, q.y),
}));

/**
 * How far a copy put beside something keeps from it, everywhere: two grid
 * steps. Closer, a copied line can be drawn along one already there -- the
 * two read as one pipe, or as joined -- and a line the router has to go round
 * something is not the line that was copied.
 */
const CLEAR = 20;

/**
 * What a copy covers where it was copied from: its symbols, the dots of its
 * junctions, and its lines as they are drawn -- the original's own drawing,
 * where the line is on the drawing between the same two things in the same
 * places, and otherwise as the router draws it between the copy's ports.
 * Each symbol at the size the original was measured at, since a copy is not
 * measured until it is drawn.
 */
function footprint(clip: Clip, existing: Node[], geometry?: PasteGeometry): Rect[] {
  const there = new Map(existing.map(n => [n.id, n]));
  const sized = clip.nodes.map(n => {
    const o = there.get(n.id);
    return o?.measured && !n.measured ? { ...n, measured: o.measured } : n;
  });
  const out = [...obstacleBoxes(sized).map(rectOfBox), ...sized.filter(isJunction).map(rectOfDot)];
  if (!geometry) return out;
  const byId = new Map(sized.map(n => [n.id, n]));
  const inPlace = (id: string) => {
    const o = there.get(id), c = byId.get(id);
    return !!o && !!c && o.position.x === c.position.x && o.position.y === c.position.y;
  };
  for (const e of clip.edges) {
    const drawn = inPlace(e.source) && inPlace(e.target) ? geometry.drawn.get(e.id) : undefined;
    const pts = drawn ?? (geometry.endOf ? drawnRoute(e, byId, geometry.endOf) : null);
    if (pts && pts.length > 1) out.push(...rectsOfLine(pts));
  }
  return out;
}

/**
 * Where a copy of a whole group lands: beside the original, clear of it and
 * of everything else on `page`. Null for a copy small enough that one
 * offset along shows it as a copy.
 *
 * Forty pixels along is a copy of a valve. A copy of a bay half a screen
 * across forty pixels along lies over the bay, its symbols on the bay's and
 * its lines criss-crossing the bay's, with nothing to tell which is which.
 * Beside it -- to the right, where the next bay of a stand goes -- and past
 * anything already there, the copy is somewhere it can be seen and dragged
 * from.
 *
 * Clear means the copy's lines and junctions as well as its symbols, and the
 * lines and junctions already there as well as theirs (`geometry`): each kept
 * CLEAR from every one of the others. Kept clear of symbols only, a copy's
 * pipe landed on another copy's line and across a tank beside it, and the
 * router, with a symbol in its way, drew it again as something that was not
 * what was copied -- its tees put on the new shape, its branches bent to
 * follow them. So the spot is looked for one copy's width at a time to the
 * right until nothing of the copy is near anything, and there the copy is
 * drawn exactly as the original is.
 */
function besideOffset(clip: Clip, existing: Node[], page: string, geometry?: PasteGeometry): Pt | null {
  const mine = footprint(clip, existing, geometry);
  if (!mine.length) return null;
  const x0 = Math.min(...mine.map(r => r.x0)), x1 = Math.max(...mine.map(r => r.x1));
  const y0 = Math.min(...mine.map(r => r.y0)), y1 = Math.max(...mine.map(r => r.y1));
  if (x1 - x0 <= 2 * PASTE_OFFSET.x && y1 - y0 <= 2 * PASTE_OFFSET.y) return null;
  const here = existing.filter(n => pageOf(dataOf(n)) === page);
  const there = [
    ...obstacleBoxes(here).map(rectOfBox),
    ...here.filter(isJunction).map(rectOfDot),
    ...[...(geometry?.drawn.values() ?? [])].flatMap(rectsOfLine),
  ];
  const clash = (d: Pt) => mine.some(r => there.some(t =>
    r.x0 + d.x - CLEAR <= t.x1 && t.x0 <= r.x1 + d.x + CLEAR && r.y0 + d.y - CLEAR <= t.y1 && t.y0 <= r.y1 + d.y + CLEAR));
  for (let k = 1; ; k++) {
    const d = { x: (x1 - x0 + PASTE_OFFSET.x) * k, y: 0 };
    if (!clash(d)) return d;
  }
}

export interface PasteOptions {
  /**
   * Where the copy lands relative to the original. Without one it lands at
   * the first free step: see `pasteOffset`.
   */
  offset?: Pt;
  /** The lines already on the drawing, so a pasted line never takes one's id. */
  edges?: Edge[];
  /** The page's lines as drawn and its ports, so a copy lands clear of the lines too: see `besideOffset`. */
  geometry?: PasteGeometry;
}

/**
 * The copy, as it will be added to the drawing.
 *
 * `existing` is what is already there, so tags can be numbered past it and
 * the paste lands on the page being looked at, clear of the copies pasted
 * before it. Pasted symbols come back selected and everything else is left
 * alone, so a paste followed by a drag moves the copy and not the original.
 */
export function pasteClip(
  clip: Clip,
  existing: Node[],
  page: string,
  { offset, edges: existingEdges = [], geometry }: PasteOptions = {},
): { nodes: Node[]; edges: Edge[] } {
  const delta = offset ?? pasteOffset(clip, existing, page, geometry);
  const idMap = new Map<string, string>();
  for (const n of clip.nodes) {
    idMap.set(n.id, n.type === 'JUNCTION' ? nextJunctionId() : nextNodeId());
  }

  // Line ids, before any node is written, because a probe can be clipped to
  // a line. Each is checked against the drawing *and* the lines named earlier
  // in this paste: two lines joining the same pair of symbols through
  // different ports would otherwise both be called `a-b`.
  //
  // They are handed out by position in the clip, not looked up by the
  // copied line's id. Drawings saved before ids were checked can hold two
  // lines of one id -- exactly the corruption this is here to stop -- and a
  // lookup by id gave both copies whichever was minted last, writing a fresh
  // duplicate while the check stood by. The id map is only for a probe's
  // clip, where an ambiguous id can do no better than the first line of it.
  const takenIds = new Set(existingEdges.map(e => e.id));
  const lineIds = clip.edges.map(e => {
    const id = freshEdgeId(`${idMap.get(e.source)}-${idMap.get(e.target)}`, takenIds);
    takenIds.add(id);
    return id;
  });
  const edgeMap = new Map<string, string>();
  clip.edges.forEach((e, i) => { if (!edgeMap.has(e.id)) edgeMap.set(e.id, lineIds[i]); });

  // Tags are numbered against the drawing *and* against the copies placed
  // before this one in the same paste, so eight valves land as eight tags.
  const taken = existing.map(n => dataOf(n)?.label ?? '');

  const placed = clip.nodes.map(n => {
    const d = dataOf(n);
    const next: PIDNodeData & { along?: { from?: string; to?: string } } = { ...d, page };
    if (d?.label && d.componentType && d.componentType !== 'REGION' && d.componentType !== 'TEXT') {
      const tag = numberTag(`${tagStem(d.label)}_#`, taken);
      taken.push(tag);
      next.label = tag;
    }
    if (d?.attachedTo) {
      const host = idMap.get(d.attachedTo) ?? edgeMap.get(d.attachedTo);
      if (host) next.attachedTo = host;
      else delete next.attachedTo;
    }
    // A tee remembers which nodes ended its pipe. The copy's pipe ends at the
    // copies of those, when they came along; one that did not is not on the
    // copy's pipe at all, and naming the original there would make the copy
    // compare itself with the original's pipe.
    const along = (d as { along?: { from?: string; to?: string } } | undefined)?.along;
    if (along) {
      const { from, to, ...rest } = along;
      const f = from !== undefined ? idMap.get(from) : undefined;
      const t = to !== undefined ? idMap.get(to) : undefined;
      next.along = { ...rest, ...(f ? { from: f } : {}), ...(t ? { to: t } : {}) };
    }
    return {
      ...n,
      id: idMap.get(n.id)!,
      selected: true,
      data: next as unknown as Record<string, unknown>,
    } as Node;
  });

  const lines = clip.edges.map((e, i) => ({
    ...e,
    id: lineIds[i],
    source: idMap.get(e.source)!,
    target: idMap.get(e.target)!,
    selected: false,
  } as Edge));

  // Then the whole copy moves at once: positions, every stored corner of the
  // lines it carries (hand-drawn and pipe-given alike -- both are absolute),
  // and each tee's record of where its pipe's ends were.
  return translateSubgraph(placed, lines, new Set(idMap.values()), delta);
}
