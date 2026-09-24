import type { Edge, Node, XYPosition } from '@xyflow/react';
import { Position } from '@xyflow/react';
import type { PIDNodeData } from './types';
import { pageOf } from './pages';
import { drawnCorners } from './edgeGeometry';
import { lineAt } from './lineHit';
import type { DrawnLine } from './lineHit';
import { nearestOnPolyline, pointAt, pointsToPath } from './route';
import type { End, Pt } from './route';
import type { EndLookup } from './junctions';
import { drawnRoute } from './lineRoute';
import { unmeasuredEnd } from './unmeasured';

/**
 * Instruments clip to what they are measuring.
 *
 * Wiring a thermocouple into the graph -- tank outlet to RTD, RTD onward --
 * was wrong in both directions. On the drawing it meant a temperature probe
 * could only be placed by breaking a line and re-joining it. In a solve it was
 * worse: `feedtwin.solve` peels a probe off as a `DeadEnd` precisely because it
 * carries no flow, so every one of them was two unknowns and a branch
 * modelling a stub that does not exist.
 *
 * A sensor is a *measurement point*: "report the pressure here". So dropping
 * one on a tank, a valve or a line attaches it to that thing and draws a
 * leader, and no edge is created. Which is also what people were trying to do
 * when they dropped it there.
 */

/**
 * Component types that attach rather than connect.
 *
 * Temperature probes and load cells only. A gauge or a transducer is a fitting
 * -- it screws into a tee or a port and is part of the feed system -- so it
 * connects like everything else.
 */
export const INSTRUMENTS = new Set(['RTD', 'TC', 'LC']);

export const isInstrument = (type?: string) => !!type && INSTRUMENTS.has(type);

/**
 * Plumbed instruments: they screw into the system rather than clipping to it.
 *
 * A transducer and a gauge are fittings -- there is a hole in the pipe and a
 * thread in the hole -- so they connect, and they have exactly one port to
 * connect with. That single port is what makes dropping one on a line
 * unambiguous: there is only one thing it could mean.
 */
export const TAPPED = new Set(['PT', 'PG']);

export const isTapped = (type?: string) => !!type && TAPPED.has(type);

/**
 * Hardware that sits *in* a run: one port in, one port out, and the pipe is
 * the same pipe on both sides. The same set `feedtwin.pid.document` calls
 * INLINE_TYPES, and it has to stay the same set, because this is what
 * decides that dropping one on a line breaks the line around it -- and that
 * deleting one from a line heals the line -- and feed-twin has to agree that
 * what it then reads is one run with a part in it.
 */
export const INLINE = new Set(['MAN', 'ROT', 'SOL', 'PR', 'RV', 'CV', 'QD']);

export const isInline = (type?: string) => !!type && INLINE.has(type);

/**
 * How big a node is, before ReactFlow has measured it.
 *
 * `measured` arrives a render after a node does, and until then everything
 * fell back to 60 x 60 -- which is a quarter of the drawing away from the
 * truth for a junction, a ten-pixel dot. Anything hit-testing or picking a
 * face against a junction created in the same batch was therefore aiming at a
 * point 25 px off the pipe.
 */
export function nodeSize(n: Node): { w: number; h: number } {
  const type = (n.data as unknown as PIDNodeData)?.componentType;
  const fallback = type === 'JUNCTION' ? 10 : 60;
  return {
    w: n.measured?.width ?? fallback,
    h: n.measured?.height ?? fallback,
  };
}

/** A node's centre in flow coordinates. */
export function centreOf(n: Node): XYPosition {
  const { w, h } = nodeSize(n);
  return { x: n.position.x + w / 2, y: n.position.y + h / 2 };
}

export interface AttachTarget {
  id: string;
  kind: 'node' | 'edge';
}

/**
 * Where on its host an instrument is clipped.
 *
 * `attachedTo` names the host, as it always has, and is what feed-twin reads.
 * `attachedAt` is new and only the drawing's: on a line, the fraction of the
 * line's drawn length, from its source end, at which the probe was dropped.
 * Without it a probe on a line could only be drawn as clipped to the line's
 * middle, and nothing that cut the line in two could tell which half it was
 * on.
 */
export interface ClipData {
  attachedTo?: string;
  attachedAt?: number;
}

const clipOf = (n: Node) => n.data as unknown as PIDNodeData & ClipData;

/** A host, and for a line, how far along it the clip is. */
export interface Clip extends AttachTarget {
  /** Fraction of the line's drawn length from its source end. Lines only. */
  at?: number;
}

/** How near the pipe a drop has to land to clip to it, in flow px. */
const TOLERANCE = 14;

/**
 * What a probe dropped at `point` clips to, and where on it.
 *
 * Lines used to be tested against the straight chord between the two end
 * symbols' centres. On a straight run that is the pipe; on an L, a Z or a U
 * it is empty canvas. A probe dropped on the drawn pipe of a bent line missed
 * it and was reported floating, while one dropped in the empty space inside
 * the bend clipped -- and drew its leader to a dot a hundred pixels off the
 * pipe. So the test is `lineAt` over the lines as drawn, the same hit test a
 * valve or a transducer dropped on a line uses, and the answer includes how
 * far along the line the drop landed, for the leader to land there too.
 */
export function clipAt(
  point: XYPosition,
  nodes: Node[],
  edges: Edge[],
  selfId?: string,
  page?: string,
  /**
   * The lines as rendered. Without them each line is taken from what it last
   * published (`drawnCorners`), or routed here the way it routes itself --
   * which is what a caller with no DOM gets.
   */
  lines?: DrawnLine[],
): Clip | null {
  const here = (n: Node) =>
    !page || pageOf(n.data as unknown as PIDNodeData) === page;

  // Components first: dropping a probe on a valve that happens to sit on a
  // line means the valve, which is the more specific of the two.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.id === selfId || !here(n)) continue;
    const t2 = (n.data as unknown as PIDNodeData)?.componentType;
    // Never clip a probe to another probe, and never to a section box: a
    // region is scenery drawn over half the diagram, so it would swallow
    // every drop made inside it.
    if (isInstrument(t2) || t2 === 'REGION' || t2 === 'TEXT') continue;
    const { w, h } = nodeSize(n);
    if (point.x >= n.position.x && point.x <= n.position.x + w &&
        point.y >= n.position.y && point.y <= n.position.y + h) {
      return { id: n.id, kind: 'node' };
    }
  }

  // Then lines on this page: both ends on it, as for drawing one.
  const byId = new Map(nodes.map(n => [n.id, n]));
  const onPage = edges.filter(e => {
    const a = byId.get(e.source), b = byId.get(e.target);
    return !!a && !!b && here(a) && here(b);
  });
  const ids = new Set(onPage.map(e => e.id));
  const candidates = lines
    ? lines.filter(l => ids.has(l.id))
    : [...lineRoutes(nodes, onPage)].map(([id, pts]) => ({ id, d: pointsToPath(pts) }));
  const hit = lineAt(candidates, point, TOLERANCE);
  return hit ? { id: hit.id, kind: 'edge', at: hit.t } : null;
}

/** Everything clipped to one host. */
export function attachedTo(nodes: Node[], hostId: string): Node[] {
  return nodes.filter(n => (n.data as unknown as PIDNodeData)?.attachedTo === hostId);
}

/**
 * Move instruments by the same delta as the component they are clipped to.
 *
 * React Flow's own `parentId` would do this, and is not used on purpose: it
 * makes a child's position relative to its parent, which changes what is
 * stored, and it requires parents to be ordered before children in the array.
 * Both are migrations to every saved diagram in return for a drag behaviour
 * that is four lines here.
 */
export function dragAttached(
  nodes: Node[],
  hostId: string,
  delta: XYPosition,
): Node[] {
  if (delta.x === 0 && delta.y === 0) return nodes;
  return nodes.map(n =>
    (n.data as unknown as PIDNodeData)?.attachedTo === hostId
      ? { ...n, position: { x: n.position.x + delta.x, y: n.position.y + delta.y } }
      : n,
  );
}

// ── Lines as drawn ───────────────────────────────────────────────────────────

/**
 * A line that has not drawn yet, routed here as the canvas will draw it
 * (`drawnRoute`: round the symbols on its page when it routes itself, through
 * its corners when it has them), between its ports where the symbols draw
 * them before anything is measured (`unmeasuredEnd`). A route of its own --
 * plain, between ports guessed at from the side facing the other end -- ran
 * through a symbol the canvas goes round, and landed a leader somewhere the
 * line would not be.
 */
function routeOfEdge(e: Edge, byId: Map<string, Node>): Pt[] | null {
  const s = byId.get(e.source), t = byId.get(e.target);
  if (!s || !t) return null;
  // A line that names no port on an end, as some old ones do, is drawn from
  // the middle of the side facing its other end.
  const endOf: EndLookup = (n, h) => unmeasuredEnd(n, h) ?? sideFacing(n, centreOf(n.id === s.id ? t : s));
  return drawnRoute(e, byId, endOf);
}

/** The middle of the side of `node` facing `towards`, a handle's width out. */
function sideFacing(node: Node, towards: Pt): End {
  const { w, h } = nodeSize(node);
  const c = { x: node.position.x + w / 2, y: node.position.y + h / 2 };
  const dx = towards.x - c.x, dy = towards.y - c.y;
  const out = 3;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { x: node.position.x + w + out, y: c.y, side: Position.Right } : { x: node.position.x - out, y: c.y, side: Position.Left };
  }
  return dy >= 0 ? { x: c.x, y: node.position.y + h + out, side: Position.Bottom } : { x: c.x, y: node.position.y - out, side: Position.Top };
}

/**
 * Every line's corners, as drawn.
 *
 * What a line published the last time it drew (`drawnCorners`, or a snapshot
 * of it the caller passes) wins; a line that has not drawn -- it was added in
 * this batch, or there is no canvas -- is routed here the way it will route
 * itself. Either way the answer is the pipe, not the chord between two
 * centres.
 */
export function lineRoutes(
  nodes: Node[],
  edges: Edge[],
  drawn: ReadonlyMap<string, Pt[]> = drawnCorners(),
): Map<string, Pt[]> {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const out = new Map<string, Pt[]>();
  for (const e of edges) {
    const pts = drawn.get(e.id) ?? routeOfEdge(e, byId);
    if (pts && pts.length >= 2) out.set(e.id, pts);
  }
  return out;
}

/**
 * Where the leader line from an instrument should land.
 *
 * The host's centre for a component. For a line, the point `at` of the way
 * along the line as drawn, or half way along it for a probe clipped before
 * the position was kept -- on the pipe, whatever shape the pipe is. The
 * midpoint of the chord between the two ends' centres, which is what this
 * used to answer, is on the pipe only when the pipe is straight.
 */
export function leaderTarget(
  attachedTo: string,
  nodes: Node[],
  edges: Edge[],
  at?: number,
  drawn?: ReadonlyMap<string, Pt[]>,
): XYPosition | null {
  const host = nodes.find(n => n.id === attachedTo);
  if (host) return centreOf(host);
  const edge = edges.find(e => e.id === attachedTo);
  if (!edge) return null;
  const pts = lineRoutes(nodes, [edge], drawn).get(edge.id);
  return pts ? pointAt(pts, at ?? 0.5)?.point ?? null : null;
}

/** Instrument size, for placing one clear of its host. */
const PROBE = 60;
const GAP = 14;

/**
 * Move a freshly attached instrument off the thing it measures.
 *
 * Up and to the right of a component, and just off the line for a line, which
 * is where a draughtsman puts a tag anyway. Only the initial placement -- drag
 * it wherever you like afterwards, and the leader follows.
 */
export function clearOfHost(
  host: AttachTarget,
  dropped: XYPosition,
  nodes: Node[],
  edges: Edge[],
  /** Where along the line it clipped, for a line. */
  at?: number,
): XYPosition {
  if (host.kind === 'node') {
    const n = nodes.find(x => x.id === host.id);
    if (!n) return dropped;
    return {
      x: n.position.x + (n.measured?.width ?? PROBE) + GAP,
      y: n.position.y - GAP,
    };
  }
  const to = leaderTarget(host.id, nodes, edges, at);
  if (!to) return dropped;
  return { x: to.x + GAP, y: to.y - PROBE - GAP };
}

/**
 * Probes clipped to a line that has just been replaced, re-clipped to the
 * line that now holds their clip point.
 *
 * Splitting a line round a tee, putting a valve into it, or healing it when a
 * tee or valve comes out, all replace it with lines under new ids. A probe
 * still naming the old id measured nothing and drew no leader, and nothing
 * said so. This sends each such probe to whichever new line passes nearest
 * the point it was clipped at, and records how far along that line it now is.
 *
 * `newEdges` are the replacement lines with their drawn corners, in order
 * from the old line's source end to its target end. `oldPoints` is the old
 * line as it was drawn; when it is not given the replacements laid end to end
 * stand in for it, which is exact for a split and near enough for a part put
 * into the line. A line healed from two must be given `oldPoints`, because
 * the healed line alone does not say where the old half lay along it.
 *
 * Returns the same array when no probe was clipped to `oldEdgeId`.
 */
export function remapAttachments(
  nodes: Node[],
  oldEdgeId: string,
  newEdges: { id: string; points: Pt[] }[],
  oldPoints?: Pt[],
): Node[] {
  if (!newEdges.length || !nodes.some(n => clipOf(n)?.attachedTo === oldEdgeId)) return nodes;
  const drawnNew = newEdges.filter(e => e.points.length >= 2);
  const before = oldPoints && oldPoints.length >= 2 ? oldPoints : drawnNew.flatMap(e => e.points);
  return nodes.map(n => {
    const clip = clipOf(n);
    if (clip?.attachedTo !== oldEdgeId) return n;
    const p = before.length >= 2 ? pointAt(before, clip.attachedAt ?? 0.5)?.point : undefined;
    let host = newEdges[0].id;
    let at: number | undefined;
    if (p) {
      let best = Infinity;
      for (const e of drawnNew) {
        const near = nearestOnPolyline(e.points, p);
        if (near && near.dist < best) { best = near.dist; host = e.id; at = near.t; }
      }
    }
    const data: Record<string, unknown> = { ...n.data, attachedTo: host };
    if (at === undefined) delete data.attachedAt;
    else data.attachedAt = at;
    return { ...n, data };
  });
}
