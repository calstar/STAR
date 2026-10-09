import * as React from 'react';
import type { Edge, InternalNode, Node } from '@xyflow/react';
import { reseatJunctions } from './junctions';
import type { Dragging, EndLookup } from './junctions';
import type { Obstacles } from './routeGrid';
import type { Graph } from './history';

/**
 * The reseat, as the canvas runs it.
 *
 * `reseatJunctions` is what keeps every tee on its pipe and every line on
 * the faces that draw it best. It needs the nodes, the lines and the ports as
 * React Flow measured them all at once, and only the render has all three,
 * so it runs after the render, as an effect, and puts what it settles into
 * state. The reseat is idempotent -- what it hands back it hands back again
 * unchanged, as the same arrays -- so that second render finds nothing to do
 * and the effect stops.
 *
 * Three things around it are the canvas's, and live here so they can be run
 * and tested as the canvas runs them, not as a copy of it:
 *
 * - when it runs: on any change to the drawing, and on any change to the
 *   ports as measured (`handleSignature`). A turned symbol is re-measured a
 *   frame after the turn, and a sixty-pixel symbol turned a quarter is the
 *   same size, so no change to the drawing announces it: without the ports
 *   in its dependencies the reseat seated tees on the ports the symbol had
 *   before the turn, and nothing ran it again until an unrelated click;
 * - the guard against it running itself for ever (`reseatOnce`);
 * - saying that what it changes is a correction, not an edit, to the history
 *   (`markCorrection`) and to whoever keeps the autosave's baseline.
 */

/**
 * How many runs in a row the reseat may make on drawings it produced itself
 * before it is taken to be chasing its own tail. A reseat that works settles
 * in one; this only stops something that never does from taking the page
 * down with "maximum update depth exceeded".
 */
export const RUNAWAY = 30;

export interface ReseatGuard {
  /** Runs in a row, each on the drawing the one before it handed back. */
  runs: number;
  /** What the last run handed back, when it changed anything. */
  last: Graph | null;
  /** Whether this runaway has been reported. */
  warned: boolean;
  /**
   * The drawing the last run left settled -- what it handed back, or what it
   * was given when it changed nothing -- and everything else it was run on.
   */
  settled: Graph | null;
  inputs: readonly unknown[];
}

export const freshGuard = (): ReseatGuard => ({ runs: 0, last: null, warned: false, settled: null, inputs: [] });

/**
 * The same drawing as far as the reseat can tell: node for node and line for
 * line, the same position, size, data and page flag, the same ends and faces
 * and data. What differs is only what React Flow keeps on a node or line for
 * itself -- `selected`, `dragging` -- which nothing the reseat does reads.
 */
export function sameDrawing(a: Graph, b: Graph): boolean {
  if (a.nodes === b.nodes && a.edges === b.edges) return true;
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false;
  for (let i = 0; i < a.nodes.length; i++) {
    const x = a.nodes[i], y = b.nodes[i];
    if (x === y) continue;
    if (x.id !== y.id || x.type !== y.type || x.position !== y.position || x.data !== y.data
      || x.width !== y.width || x.height !== y.height || !!x.hidden !== !!y.hidden
      || x.measured?.width !== y.measured?.width || x.measured?.height !== y.measured?.height) return false;
  }
  for (let i = 0; i < a.edges.length; i++) {
    const x = a.edges[i], y = b.edges[i];
    if (x === y) continue;
    if (x.id !== y.id || x.type !== y.type || x.source !== y.source || x.target !== y.target
      || x.sourceHandle !== y.sourceHandle || x.targetHandle !== y.targetHandle || x.data !== y.data) return false;
  }
  return true;
}

/**
 * One run of the reseat on `g`: the drawing it settles `g` to, or null when
 * there is nothing to change -- or when the guard holds it back.
 *
 * A drawing the last run left settled, run on the same `inputs` (the ports
 * as measured, the drag in progress), is settled: the reseat is idempotent,
 * so running it again on its own answer only proves that, and cost as much
 * as the run that mattered -- on every drag tick, since the answer comes
 * straight back through the effect. Nor is a drawing that differs from it
 * only in what is selected: a click cost a whole reseat.
 *
 * The guard counts only runs on arrays the last run itself handed back.
 * It used to count every run in a one-second window, the user's own changes
 * included, and a symbol dragged at an ordinary speed makes thirty changes
 * in well under a second: tee-following switched itself off in the middle
 * of the drag, the tee was left behind with its halves hooked, and it jumped
 * to where it belonged on the next unrelated click. A change from anywhere
 * else -- a drag step, a key, a measurement -- is not the reseat running
 * itself, and starts the count again. With its own answers taken as settled
 * the count only grows while what else it runs on keeps changing under an
 * answer it keeps changing.
 */
export function reseatOnce(
  guard: ReseatGuard, g: Graph, seat: (g: Graph) => Graph, warn: (message: string) => void = () => {},
  inputs: readonly unknown[] = [],
): Graph | null {
  const sameInputs = inputs.length === guard.inputs.length && inputs.every((x, i) => Object.is(x, guard.inputs[i]));
  if (guard.settled && sameInputs && sameDrawing(guard.settled, g)) return null;
  const own = !!guard.last && guard.last.nodes === g.nodes && guard.last.edges === g.edges;
  if (own) guard.runs++;
  else { guard.runs = 0; guard.warned = false; }
  if (guard.runs > RUNAWAY) {
    if (!guard.warned) {
      guard.warned = true;
      warn('pid-designer: tees would not settle; leaving them where they are');
    }
    return null;
  }
  const re = seat(g);
  const changed = re.nodes !== g.nodes || re.edges !== g.edges;
  guard.last = changed ? re : null;
  guard.settled = changed ? re : g;
  guard.inputs = inputs;
  return changed ? re : null;
}

export interface ReseatOptions {
  nodes: Node[];
  edges: Edge[];
  /** Where a port is: React Flow's measured handle bounds, a tee's end carrying J_END. */
  endOf: EndLookup;
  /** What automatic routes go round, page by page (`obstaclesByPage`). */
  obstacles?: Obstacles;
  /** Whether React Flow has measured every node. Before that a port is a guess, and a tee is never seated on a guess. */
  ready: boolean;
  /** The ports as measured (`handleSignature`): the reseat runs again when they change under an unchanged drawing. */
  ports?: string;
  /** The drag in progress, if one is (`Dragging`), read when the reseat runs. */
  drag?: () => Dragging | null;
  /**
   * React's setters. The reseat hands them an update that applies only to
   * the drawing it seated (see the effect).
   */
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  /** The history's: what the reseat is about to set is a correction of `before`, not an edit. */
  markCorrection?: (before: Graph, after: Graph) => void;
  /** Told of each correction too, after the history: for the autosave's baseline. */
  onCorrect?: (before: Graph, after: Graph) => void;
  /** The reseat itself; a test can count its calls. */
  reseat?: (nodes: Node[], edges: Edge[], endOf: EndLookup, obstacles?: Obstacles, drag?: Dragging | null) => Graph;
  warn?: (message: string) => void;
}

/**
 * The reseat effect. Returns `settleAgain`, which runs the reseat once more
 * on the drawing as it then is, whatever the guard has counted: what the
 * canvas does when a drag ends, so that whatever happened during it, the
 * drawing let go of is a settled one.
 */
export function useReseat(o: ReseatOptions): () => void {
  const guard = React.useRef<ReseatGuard>(freshGuard());
  const [again, setAgain] = React.useState(0);
  // The callbacks are read when the effect runs, not listed as what makes
  // it run: a new callback is not a change to the drawing.
  const latest = React.useRef(o);
  latest.current = o;
  const { nodes, edges, endOf, obstacles, ready, ports } = o;
  React.useEffect(() => {
    // Not until React Flow has measured every node. Before then a port's
    // place is a guess -- a node not yet measured has no handles to read --
    // and a pipe routed to a guess moves every tee on it, which the first
    // measurement then moves back: opening a drawing would move its tees.
    if (!ready) return;
    const { reseat = reseatJunctions, setNodes, setEdges, markCorrection, onCorrect, warn, drag } = latest.current;
    const moving = drag?.() ?? null;
    const before = { nodes, edges };
    const after = reseatOnce(
      guard.current, before, g => reseat(g.nodes, g.edges, endOf, obstacles, moving), warn ?? console.warn,
      [endOf, ports, moving],
    );
    if (!after) return;
    // The seat is the drawing settling, not an edit: undo amends the entry
    // it corrected instead of stacking the correction on top of it.
    markCorrection?.(before, after);
    onCorrect?.(before, after);
    // Only onto the drawing it seated. A drag reports its next step before
    // this effect has run, and the step's own update -- the moved nodes, the
    // corners carried with them -- is already queued: set outright, this
    // settled drawing of the step before replaced it, and a bay dragged
    // whole lost a step's corner shift while its nodes kept theirs, leaving
    // its hand corners behind and a tee pushed onto the wrong leg. A drawing
    // that has moved on is reseated on its own, once it renders.
    if (after.nodes !== nodes) setNodes(cur => (cur === nodes ? after.nodes : cur));
    if (after.edges !== edges) setEdges(cur => (cur === edges ? after.edges : cur));
  }, [nodes, edges, endOf, obstacles, ready, ports, again]);
  return React.useCallback(() => {
    guard.current = freshGuard();
    setAgain(n => n + 1);
  }, []);
}

/**
 * What the autosave compares a drawing with -- the text it last wrote, or
 * opened -- and whether a correction has found the drawing edited since.
 */
export interface Baseline {
  saved: string;
  edited: boolean;
}

/**
 * The autosave's baseline after the reseat corrected `before` into `after`.
 *
 * A correction of the drawing as last saved is not a reason to save it. The
 * drawing as opened is the case that matters: it is seated on the ports as
 * this screen measured them and routed round the symbols as this screen has
 * them, and a correction made there and saved at once was a rewrite nobody
 * asked for, saved the moment the drawing was opened -- and by everybody who
 * merely opened it. So when `before` is exactly what was saved, `after`
 * becomes what was saved; the correction goes to the server with the next
 * real edit, and until then every screen that opens the drawing makes it
 * again, the same. A correction of an edited drawing moves nothing: the
 * edit is saved, corrected.
 *
 * Once a correction finds the drawing edited, it stays edited until the next
 * save, and the drawing is not written out again to find that out: a drag
 * is corrected on every step.
 */
export function carryBaseline(
  b: Baseline, saved: string, before: Graph, after: Graph, text: (g: Graph) => string,
): Baseline {
  if (b.saved === saved && b.edited) return b;
  return text(before) === saved ? { saved: text(after), edited: false } : { saved, edited: true };
}

/**
 * A fingerprint of every port as React Flow measured it: each node's handle
 * bounds, relative to the node. What the reseat reads through `endOf`
 * besides the drawing, so it runs again when this changes.
 *
 * Read from React Flow's store, where `updateNodeInternals` replaces a node's
 * handle bounds after a re-measure and then notifies every subscriber, with
 * or without a change to the drawing. Each node's part is worked out once per
 * handle-bounds object, which is replaced exactly when they are re-measured,
 * so the store's other traffic -- a pan, a zoom, a drag -- costs a join.
 */
export function handleSignature(lookup: Map<string, InternalNode>): string {
  let out = '';
  for (const [id, n] of lookup) {
    const hb = n.internals.handleBounds;
    let s = '';
    if (hb) {
      s = signatures.get(hb) ?? '';
      if (!s) {
        s = [...(hb.source ?? []), ...(hb.target ?? [])]
          .map(h => `${h.id}:${h.position}:${h.x},${h.y},${h.width},${h.height}`).join(';') || '-';
        signatures.set(hb, s);
      }
    }
    out += `${id}=${s}|`;
  }
  return out;
}
const signatures = new WeakMap<object, string>();
