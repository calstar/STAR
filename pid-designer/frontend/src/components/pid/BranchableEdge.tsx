import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { BaseEdge, useConnection, useNodesData, useReactFlow, useStore, useStoreApi, type EdgeProps } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import { J_END, crowdOf, isJunction, setHandCorners, splitSpot, thawPipe } from './junctions';
import type { EndLookup } from './junctions';
import { splitEdgeAt } from './splitEdge';
import {
  dragSegment, gridAlong, jogSegment, nearestOnPolyline, pathPoints, polylineLength, routeOrthogonal, waypointsOf,
} from './route';
import type { Box, End, Pt } from './route';
import { inTheWay, routeOfLine, routesItself, sameBoxes } from './lineRoute';
import { NO_BOXES, obstacleGrid, obstaclesByPage } from './routeGrid';
import type { BoxGrid } from './routeGrid';
import { crossingsOf, pathWithHops } from './hops';
import { NO_LINES, publishEdge, sameRoute, unpublishEdge, useLineView } from './edgeGeometry';
import { useEdgeFluidColor } from './FluidContext';
import { useReadOnly } from '@stardesign-ui';
import { useTool, useToolDone } from './ToolContext';
import { lineSourceAt, nextFrame, useBranchDrag } from './BranchDrag';
import type { BranchSource, DropLookups } from './BranchDrag';
import { onScreen } from './drop';
import { handToLine, handedOn, pageLines } from './lineHit';

export { nearestOnPath, faceTowards } from './route';

/**
 * A pipe: orthogonal, every segment of it movable once it is picked, a tee
 * wherever you want one, and a hop wherever it crosses another.
 *
 * **Orthogonal, not smoothstep.** A P&ID is drawn with square corners, and the
 * rounded ones React Flow supplies by default read as a flow chart.
 *
 * **Press anywhere on a line and pull, and you are drawing a branch.** The
 * dot riding the pointer along the run is where the tee will go -- the spot
 * the tee will actually be put, clear of the bends, the ends and the tees
 * already there, not the bare point under the pointer. A press that does not
 * move is a click, and still selects the line. Alt-click, or the Junction
 * tool, puts a tee in at the dot without drawing anything from it.
 *
 * **Click a line and its segments can be moved.** Automatic routing puts a
 * crossbar halfway, which is exactly where the next line also wants to be,
 * and a bay with eight lines leaving one tank turns into a stack of
 * overlapping runs nobody can follow. A picked line shows a grip on each
 * segment; drag it and the segment moves across, the two ends stay on their
 * ports, and the corners are stored on the line (see `routeThrough`) so the
 * routing somebody chose survives a reload. Alt-drag puts a detour into a
 * segment instead of moving the whole of it. Double-click a grip and the
 * line routes itself again. The grips used to be there on every line the
 * pointer crossed, at the middle of every segment -- exactly where people aim
 * to start a branch -- so the same press-and-pull reshaped the line at its
 * middle and branched it everywhere else, with nothing on screen to say
 * which it would be. Now reshaping is something done to a line picked for it.
 *
 * **Near a symbol's port, a line's end is the end.** React Flow's anchor
 * there carries it to another port (`onReconnectEnd`); a press within
 * `END_REACH` of it is left to that, and does not start a branch. The anchor
 * is kept to half a grid step (`CARRY_RADIUS`), since it is the one target
 * here still given out by stacking.
 *
 * **Presses go to the line nearest the pointer**, as a drop does
 * (`lineSourceAt`), not to whichever line's element is on top: each line
 * has one hit band, `hitWidth` across, and a press or a hover inside one
 * that is nearer another line's centreline is that other line's, and so is
 * the click that follows (`handToLine`).
 *
 * **Lines that cross are not joined**, and the drawing says so: the vertical
 * one hops the horizontal one. Nothing here infers a connection from two
 * paths overlapping -- a crossing on a drawing is usually one line passing
 * over another, and guessing wrong either invents a leak path or hides a
 * real one.
 *
 * **Lines that would lie on each other are drawn apart.** A line routes
 * itself, tells the store of drawn routes where (`edgeGeometry.ts`), and
 * draws what comes back: its route, or -- for a line that routes itself and
 * would lie along another -- the same route with its middle a grid step or
 * two over (`tracks.ts`). Everything a person does to a line starts from it
 * as drawn: its grips, a segment drag, a press, the dot.
 */

/**
 * How wide a line takes the pointer, across it, in screen pixels -- just
 * under one grid step, so that at full size two lines a grid step apart never
 * share a pixel of it -- and never narrower than that on the drawing. React
 * Flow's own default was twenty on the drawing whatever the zoom, laid over
 * the line's own twelve: wider than the grid, and stacked in the order the
 * lines were made. Rounded up to whole pixels, so zooming out redraws the
 * lines a handful of times, not on every step of the wheel.
 */
const HIT = 9;
export const hitWidth = (zoom: number) => Math.ceil(onScreen(HIT, HIT, zoom));

/**
 * How far React Flow's anchor for carrying a line's end reaches, on the
 * drawing (the canvas's `reconnectRadius`): a disc this radius, centred this
 * far out along the port's stub. React Flow's own ten reached a whole grid
 * step across the line, and every line's anchors are drawn above every older
 * line, so where two lines leave ports a grid step apart -- a tank's lid, a
 * manifold -- a press or a click aimed at one line's end, nearer its own
 * centreline, carried or picked its neighbour. Half a grid step keeps each
 * anchor on its own side of the midline between the two, so the one press
 * target still settled by stacking cannot settle it wrongly.
 */
export const CARRY_RADIUS = 5;

/**
 * How far along a line from its end at a symbol's port a press is the end's:
 * as far as the anchor reaches along it. A branch started there would seat
 * its tee inside the stub, and carrying the end is the likelier intent.
 */
export const END_REACH = 2 * CARRY_RADIUS;

// ── The hover dot: one on the page, on the line nearest the pointer ─────────

type Hover = { id: string; point: Pt };
let hovered: Hover | null = null;
/** What the pointer was over when the dot was put where it is: a line's own band, or a tee's halo. */
let hoverBy: string | null = null;
const hoverListeners = new Set<() => void>();
function setHovered(next: Hover | null, by: string | null = null) {
  hoverBy = next ? by : null;
  if (hovered === next || (hovered && next && hovered.id === next.id && hovered.point.x === next.point.x && hovered.point.y === next.point.y)) return;
  hovered = next;
  for (const l of hoverListeners) l();
}
const subscribeHover = (l: () => void) => { hoverListeners.add(l); return () => { hoverListeners.delete(l); }; };
/** Where the hover dot is on this line, if it is on this line. Only the lines it leaves and joins redraw. */
function useHoverDot(id: string): Pt | null {
  const get = useCallback(() => (hovered && hovered.id === id ? hovered.point : null), [id]);
  return useSyncExternalStore(subscribeHover, get, get);
}
/** Resolved once a frame: the latest question asked replaces any still waiting. */
let hoverFrame = 0;
let hoverAsk: { by: string; run: () => void } | null = null;
function askHover(by: string, run: () => void) {
  hoverAsk = { by, run };
  if (!hoverFrame) hoverFrame = nextFrame(() => { hoverFrame = 0; const g = hoverAsk; hoverAsk = null; g?.run(); });
}
/** The dot as it stands, for a caller that is not a line: the line it is on, and where, or null for none. */
export const hoverSpot = (): Readonly<Hover> | null => hovered;
/** No dot, and none on its way. */
export function leaveHover() {
  hoverAsk = null;
  setHovered(null);
}

/** A line a press can pull a branch out of, and where on it. */
type LineSource = Extract<BranchSource, { kind: 'line' }>;
/** What the dot is placed with: the drawing, and the designer's lookups where there is a designer. */
export interface HoverLookups { getNodes: () => Node[]; getEdges: () => Edge[]; drop: DropLookups | null }

/**
 * Puts the dot, at the next frame, where a press at the pointer would put a
 * tee in: on the line `find` names then, or nowhere if it names none. `by`
 * names whatever the pointer is over, for `forgetHover`. A line asks this of
 * its own band; so does whatever lies over lines and hands them the presses
 * nearer them -- a tee's halo and ring (JunctionNode) -- so the dot there
 * says what a press does, as it does on a line.
 */
export function hoverAt(by: string, find: () => LineSource | null, look: HoverLookups): void {
  askHover(by, () => {
    const line = find();
    if (!line) { setHovered(null); return; }
    const nodes = look.getNodes();
    const point = landing(nodes, look.getEdges(), line.edgeId, line.points, gridAlong(line.points, line.at), geometryOf(look.drop, nodes));
    // A line with nowhere a tee can sit shows no dot: a press there puts none in.
    setHovered(point ? { id: line.edgeId, point } : null, by);
  });
}

/**
 * Takes the dot away when `by` has anything to do with it -- the dot is on
 * it, it was over it when the dot was put there, or it has asked where the
 * dot goes -- for a line or a tee leaving the page. A removed element is sent
 * no mouseleave: without this a line deleted from the keyboard under the
 * pointer left the dot where it was, and an undo that put the line back drew
 * the dot on it again, at a spot the pointer had long left.
 */
export function forgetHover(by: string): void {
  if (hoverAsk?.by === by) hoverAsk = null;
  if (hovered && (hovered.id === by || hoverBy === by)) setHovered(null);
}

/**
 * The spot a tee put into a line at `at` lands on: where `splitEdgeAt` will
 * put it and the reseat keep it, on the line's whole pipe (`splitSpot`),
 * given the drawing's measured ports and what routes go round.
 */
function landing(nodes: Node[], edges: Edge[], lineId: string, points: Pt[], at: Pt, geometry?: { endOf: EndLookup; obstacles: (page: string) => Box[] }): Pt | null {
  // A line not in the drawing yet has nothing to say about where a tee goes
  // but where it is pressed.
  if (!edges.some(e => e.id === lineId)) return at;
  return splitSpot(nodes, edges, lineId, points, at, undefined, geometry)?.point ?? null;
}

/**
 * The measured ports, from the designer: read once per designer, since the
 * lookup it lends never changes. And the lines as the page draws them and
 * the tees, which a tee put in keeps clear of where it can (`crowdOf`).
 */
const endOfs = new WeakMap<DropLookups, EndLookup>();
function geometryOf(drop: DropLookups | null, nodes: Node[]) {
  if (!drop) return undefined;
  let endOf = endOfs.get(drop);
  if (!endOf) { endOf = drop.scene().endOf; endOfs.set(drop, endOf); }
  return { endOf, obstacles: obstaclesByPage(nodes), crowd: crowdOf(nodes, pageLines()) };
}

/** Is a line's end at `nodeId` on a symbol's port (and so an end React Flow lets be carried)? */
const atSymbol = (nodes: Node[], nodeId: string) => { const n = nodes.find(x => x.id === nodeId); return !!n && !isJunction(n); };

export function BranchableEdge(props: EdgeProps) {
  const {
    id, source, target, sourceHandleId, targetHandleId,
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
    style, data, selected,
  } = props;

  // Whether each end is on a tee. The router routes a tee differently -- a
  // six-pixel stub and a fourteen-pixel clearance, not a symbol's sixteen
  // and forty-four -- and the faces a line is given were chosen on that
  // basis (see `pointLines`). Drawing it as if both ends were symbols is
  // what turned a chosen three-segment Z into a six-segment loop.
  const endNodes = useNodesData([source, target]);
  const isTee = (i: number) => (endNodes[i]?.data as { componentType?: string } | undefined)?.componentType === 'JUNCTION';
  const teeA = isTee(0), teeB = isTee(1);

  const { setNodes, setEdges, getNodes, getEdges, getZoom, screenToFlowPosition } = useReactFlow();
  const readOnly = useReadOnly();
  const tool = useTool();
  const done = useToolDone();
  const { begin, active: pulling, drop } = useBranchDrag();
  // A port drag in progress: the line is something it may be let go on, not
  // something to reshape, and nothing here may stand in its way.
  const connecting = useConnection(c => c.inProgress);
  const hit = useStore(s => hitWidth(s.transform[2]));
  const armed = tool === 'junction' && !readOnly;

  const strokeColor = useEdgeFluidColor(id, (data as { color?: string })?.color);
  const routing = data as { offset?: number; waypoints?: Pt[] } | undefined;

  // ── The run ────────────────────────────────────────────────────────────────
  const a: End = { x: sourceX, y: sourceY, side: sourcePosition, ...(teeA ? J_END : {}) };
  const b: End = { x: targetX, y: targetY, side: targetPosition, ...(teeB ? J_END : {}) };
  const waypoints = routing?.waypoints;
  const offset = routing?.offset ?? 0;
  // A line that routes itself goes round the symbols in its way -- see
  // lineRoute.ts, which is also what the reseat prices its faces with. It
  // asks React Flow's store only which symbols are in the way of its plain
  // route (none, nearly always), compared by what they are, so it is drawn
  // again when a symbol comes into its way or goes out of it, not whenever
  // anything on the sheet moves. A pipe's lines draw their slices of the
  // pipe as stored, and ask nothing.
  const selfRouted = routesItself(routing, endNodes[0], sourceHandleId, endNodes[1], targetHandleId);
  const plain = useMemo(() => (selfRouted ? { pts: pathPoints(routeOrthogonal(a, b, offset).d), a, b } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selfRouted, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, offset, teeA, teeB]);
  // The store is asked on every change to it -- a pan, a zoom -- and the
  // symbols are the same array until one of them changes, so the answer is
  // kept until either they or the line do.
  const asked = useRef<{ grid: BoxGrid; plain: typeof plain; boxes: Box[] } | null>(null);
  const inWay = useStore(
    useCallback(s => {
      if (!plain) return NO_BOXES;
      const grid = obstacleGrid(s.nodes);
      const last = asked.current;
      if (last && last.grid === grid && last.plain === plain) return last.boxes;
      const boxes = inTheWay(plain.pts, grid, plain.a, plain.b);
      asked.current = { grid, plain, boxes };
      return boxes;
    }, [plain]),
    sameBoxes,
  );
  const viaRun = (data as { viaRun?: boolean } | undefined)?.viaRun;
  const base = useMemo(() => routeOfLine(a, b, routing, selfRouted ? inWay : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, waypoints, viaRun, offset, teeA, teeB, selfRouted, inWay]);

  // Tell the other lines where this one routed itself, and find out how it
  // is to be drawn -- moved a grid step off a line it would lie on, when it
  // routes itself (see tracks.ts) -- and how the lines near it are. The
  // symbols a moved segment keeps out of are the canvas's, read when the
  // pass runs rather than now, and listened to by the store of drawn routes
  // rather than by this line: a symbol can move onto a moved segment
  // without this line's own route changing, and every line re-rendering on
  // every move of every symbol is what the store is there to prevent. Until
  // the pass has caught up with a route that changed, the line draws its
  // route as it routed it.
  const flow = useStoreApi();
  const sheet = useCallback(() => obstacleGrid(flow.getState().nodes), [flow]);
  useLayoutEffect(() => { publishEdge(id, base, { a, b, free: selfRouted, sheet, watchSheet: flow.subscribe }); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, base, selfRouted, sheet, flow, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, teeA, teeB]);
  // Gone from the page: its route, and any hover dot it drew or asked for.
  useEffect(() => () => { unpublishEdge(id); forgetHover(id); }, [id]);
  const view = useLineView(id);
  // Everything below -- the path, its hops, the grips, a segment drag's
  // starting shape, a press's nearest point -- works on the line as drawn.
  const pts = view && sameRoute(view.base, base) ? view.pts : base;
  const near = view?.near ?? NO_LINES;
  const hops = useMemo(() => crossingsOf(pts, near), [pts, near]);
  const drawn = useMemo(() => pathWithHops(pts, hops), [pts, hops]);

  const toFlow = useCallback((e: { clientX: number; clientY: number }) =>
    screenToFlowPosition({ x: e.clientX, y: e.clientY }, { snapToGrid: false }), [screenToFlowPosition]);

  /**
   * The line a press or a hover at `at` belongs to: the drawn line nearest
   * it, which is usually this one. With no page to read (a line drawn before
   * the page has it), this one.
   */
  const ownerAt = useCallback((at: Pt): LineSource | null => {
    const nearest = lineSourceAt(at, getZoom());
    if (nearest) return nearest.source;
    const mine = nearestOnPolyline(pts, at);
    return mine ? { kind: 'line', edgeId: id, at: mine.point, dir: mine.dir, points: pts } : null;
  }, [getZoom, pts, id]);

  /** Is `at` on `line` within `END_REACH` of an end of it that is at a symbol's port? */
  const nearCarriedEnd = useCallback((line: LineSource) => {
    const on = nearestOnPolyline(line.points, line.at);
    if (!on) return false;
    const e = line.edgeId === id ? { source, target } : getEdges().find(x => x.id === line.edgeId);
    if (!e) return false;
    const nodes = getNodes();
    return (on.s <= END_REACH && atSymbol(nodes, e.source))
      || (polylineLength(line.points) - on.s <= END_REACH && atSymbol(nodes, e.target));
  }, [id, source, target, getEdges, getNodes]);

  // ── Hovering: the dot that rides the run ───────────────────────────────────
  const hover = useHoverDot(id);
  const onMouseMove = useCallback((e: React.MouseEvent<SVGGElement>) => {
    if (readOnly || pulling || connecting) return;
    // Over a grip, the grip is what a press takes: no dot to say otherwise.
    if ((e.target as Element | null)?.closest?.('[data-grip]')) { leaveHover(); return; }
    const at = toFlow(e);
    hoverAt(id, () => {
      const owner = ownerAt(at);
      return owner && !nearCarriedEnd(owner) ? owner : null;
    }, { getNodes, getEdges, drop });
  }, [readOnly, pulling, connecting, toFlow, id, ownerAt, nearCarriedEnd, getNodes, getEdges, drop]);

  // ── Moving a segment ───────────────────────────────────────────────────────
  const [drag, setDrag] = useState<{ segment: number; jog: boolean; start: Pt; at: Pt; base: Pt[]; ends: { a: End; b: End } } | null>(null);

  const startSegmentDrag = useCallback((segment: number, e: React.PointerEvent) => {
    if (readOnly || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const start = toFlow(e);
    setDrag({ segment, jog: e.altKey, start, at: start, base: pts, ends: { a, b } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, pts, toFlow, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, teeA, teeB]);

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const now = toFlow(e);
      const delta = { x: now.x - drag.start.x, y: now.y - drag.start.y };
      // The ends as drawn, so a leg is never pushed behind a port's own
      // stub -- a tee's is six pixels, not a symbol's sixteen.
      const next = drag.jog
        ? jogSegment(drag.base, drag.segment, drag.at, delta, { ends: drag.ends })
        : dragSegment(drag.base, drag.segment, delta, { ends: drag.ends });
      // A person's corners: never marked as the pipe's, which the reseat
      // would take back, and the first edit on any line of a pipe makes the
      // whole pipe a person's (`setHandCorners`), so the rest of it cannot
      // re-route under the edit.
      setEdges(eds => setHandCorners(getNodes(), eds, id, waypointsOf(next)));
    };
    const onUp = () => setDrag(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, id, setEdges, getNodes, toFlow]);

  /** Back to routing itself: the whole pipe the line is on, as a hand edit froze the whole of it. */
  const resetRoute = useCallback((e: React.MouseEvent) => {
    if (readOnly) return;
    e.stopPropagation();
    e.preventDefault();
    setEdges(eds => thawPipe(getNodes(), eds, id));
  }, [readOnly, id, setEdges, getNodes]);

  // ── Putting a tee in, or pulling a line out ────────────────────────────────
  const placeJunction = useCallback((line: LineSource) => {
    // The same operation dropping a connection on a line performs -- see
    // splitEdge.ts -- at the spot the hover dot showed: the one the reseat
    // keeps, given the measured ports and what routes go round. No page
    // argument: a junction belongs on the page its own pipe is drawn on, and
    // `splitEdgeAt` reads that off the line's upstream end. The corners as
    // drawn go with it, which a caller working from the node boxes would
    // not have, and this line's own ends as React Flow placed them.
    const nodes = getNodes();
    const mine = line.edgeId === id ? { a, b } : {};
    const split = splitEdgeAt(nodes, getEdges(), line.edgeId, gridAlong(line.points, line.at), undefined, {
      ...mine, points: line.points, ...geometryOf(drop, nodes),
    });
    if (!split) return;
    flushSync(() => {
      setNodes(split.nodes);
      setEdges(split.edges);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, getNodes, getEdges, setNodes, setEdges, drop, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, teeA, teeB]);

  const onPointerDown = useCallback((e: React.PointerEvent<SVGGElement>) => {
    if (readOnly || e.button !== 0) return;
    const line = ownerAt(toFlow(e));
    // Left alone near a symbol's end: the press is React Flow's, which
    // carries the end, or selects the line.
    if (!line || nearCarriedEnd(line)) return;
    // Stop React Flow reading this as a pan or a box-select. Clicks and
    // double-clicks are separate events and still reach it.
    e.stopPropagation();
    e.preventDefault();
    leaveHover();
    if (armed || e.altKey) {
      placeJunction(line);
      if (armed) done();
      return;
    }
    begin(line, e);
  }, [readOnly, ownerAt, toFlow, nearCarriedEnd, armed, placeJunction, done, begin]);

  /**
   * A click, a double-click or a right-click on this line's band that is
   * nearer another line is that other line's: handed to its own element, so
   * React Flow selects it, and the designer configures or paints it, exactly
   * as if it had been clicked. A Delete after that removes the line that was
   * clicked, not its neighbour.
   */
  const handOn = useCallback((e: React.MouseEvent<SVGGElement>) => {
    // Sent here by whatever judged it this line's: kept.
    if (handedOn()) return;
    const line = ownerAt(toFlow(e));
    if (line && line.edgeId !== id) handToLine(line.edgeId, e);
  }, [ownerAt, toFlow, id]);

  // ── Grips: one per segment, on a picked line ───────────────────────────────
  const grips = useMemo(() => {
    const out: { i: number; x: number; y: number; horizontal: boolean }[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      if (Math.hypot(q.x - p.x, q.y - p.y) < 24) continue;   // too short to hold
      out.push({ i, x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, horizontal: Math.abs(p.y - q.y) < 1e-6 });
    }
    return out;
  }, [pts]);
  const showGrips = !readOnly && !pulling && !connecting && (!!selected || drag !== null);
  const showDot = !readOnly && !pulling && !connecting && hover !== null && drag === null;

  return (
    <g
      onMouseMove={onMouseMove}
      onMouseLeave={leaveHover}
      onPointerDown={onPointerDown}
      onClick={handOn}
      onDoubleClick={handOn}
      onContextMenu={handOn}
      style={{ cursor: armed ? 'crosshair' : 'pointer' }}
    >
      {/* One band that takes the pointer, `hitWidth` across -- React Flow's
          own, sized here instead of its default. */}
      <BaseEdge path={drawn} interactionWidth={hit} style={{ stroke: strokeColor, strokeWidth: 2, ...style }} />

      {showDot && (
        <circle
          cx={hover!.x} cy={hover!.y} r={armed ? 5 : 4}
          fill={armed ? strokeColor : 'var(--color-bg-primary)'} stroke={strokeColor} strokeWidth={2}
          style={{ pointerEvents: 'none' }}
        />
      )}

      {showGrips && grips.map(g => (
        <g
          key={g.i}
          data-grip=""
          onPointerDown={e => startSegmentDrag(g.i, e)}
          onClick={e => e.stopPropagation()}
          onDoubleClick={resetRoute}
          // React Flow sets `pointer-events: visibleStroke` on an edge, so a
          // shape with a fill and no stroke is invisible to the pointer no
          // matter how large it is. The grip needs saying explicitly.
          style={{ cursor: g.horizontal ? 'ns-resize' : 'ew-resize', pointerEvents: 'all' }}
        >
          {/* A generous invisible target over a small visible one. */}
          <rect
            x={g.x - (g.horizontal ? 16 : 8)} y={g.y - (g.horizontal ? 8 : 16)}
            width={g.horizontal ? 32 : 16} height={g.horizontal ? 16 : 32}
            fill="transparent" style={{ pointerEvents: 'all' }}
          />
          <rect
            x={g.x - (g.horizontal ? 7 : 1.5)} y={g.y - (g.horizontal ? 1.5 : 7)}
            width={g.horizontal ? 14 : 3} height={g.horizontal ? 3 : 14} rx={1.5}
            fill={drag?.segment === g.i ? 'var(--color-text-primary)' : strokeColor}
            opacity={drag?.segment === g.i ? 1 : 0.6}
            style={{ pointerEvents: 'all' }}
          />
        </g>
      ))}
    </g>
  );
}
