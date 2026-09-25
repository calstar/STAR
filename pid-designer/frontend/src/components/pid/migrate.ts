import type { Edge, Node } from '@xyflow/react';
import { freshEdgeId } from './ids';
import { drawnPortsOf } from './ports';
import { J_END, adoptTee, isJunction, junctionData, junctionEnd, recordPipes, seatTees } from './junctions';
import type { Face } from './junctions';
import { faceTowards, pathPoints, routeCost, routeOrthogonal } from './route';
import type { End, Pt } from './route';
import { unmeasuredEnd as portEnd } from './unmeasured';

/**
 * What an older drawing means in today's vocabulary.
 *
 * Applied once, on load, so nothing downstream has to know a symbol was ever
 * called something else. Each rule names the change and the date it landed;
 * a rule is never removed, because a drawing can be any age.
 *
 * It runs before the autosave takes its baseline, so what it rewrites is
 * what the drawing is taken to be on opening, and opening a drawing does not
 * save it back. That is also why it finishes the job it starts: a tee it
 * adopts, it puts on its pipe, since a rewrite left for the first reseat to
 * make is made after the baseline, and saved.
 */
export function migrate(d: { nodes: Node[]; edges: Edge[] }): { nodes: Node[]; edges: Edge[] } {
  // The click-to-branch tees below, which are old whatever else is true.
  const clickBranched = new Set<string>();
  let nodes = d.nodes.map(n => {
    const data = (n.data ?? {}) as Record<string, unknown>;
    // 2026-09: the standalone injector symbol is gone. It was the engine
    // without its chamber, and on a feed drawing that is the same boundary.
    if (n.type === 'INJECTOR' || data.componentType === 'INJECTOR') {
      return { ...n, type: 'ENGINE', data: { ...data, componentType: 'ENGINE' } } as Node;
    }
    // 2026-09: a tee made by click-to-branch (June to mid-September 2026) was
    // saved as a JUNCTION node with `data: {}`. Everything that knows a tee
    // from a symbol reads the component type, so it was routed as a sixty-
    // pixel box and deleted as though it were the end of a pipe.
    if (n.type === 'JUNCTION' && !data.componentType) {
      clickBranched.add(n.id);
      return { ...n, data: { ...data, componentType: 'JUNCTION', label: (data.label as string | undefined) ?? n.id } } as Node;
    }
    return n;
  });

  // 2026-09: a drawing saved before line ids were checked can hold two lines
  // of one id -- a paste named every line after its two ends, so two lines
  // between one pair of symbols came out the same. React Flow keeps one line
  // per id: it drew the second twice and the first not at all, and a tee or
  // a valve put into the one on screen cut the hidden one and deleted it.
  // Every line after the first of an id is given one of its own.
  const seen = new Set<string>();
  const every = new Set(d.edges.map(e => e.id));
  let edges = d.edges.map(e => {
    if (!seen.has(e.id)) { seen.add(e.id); return e; }
    const id = freshEdgeId(`${e.source}-${e.target}`, every);
    every.add(id);
    seen.add(id);
    return { ...e, id };
  });

  // 2026-09: the same tees' lines were saved with no port named on the symbol
  // end, which React Flow resolves to the symbol's first port -- a valve's
  // inlet, whichever way the run went. The port that reaches the tee best
  // is the one the line was drawn from, of those no other line is on: a
  // port had one line, and the line on it drawn since is where it was drawn.
  const byId = new Map(nodes.map(n => [n.id, n]));
  const onPort = new Set<string>();
  for (const e of edges) {
    if (e.sourceHandle) onPort.add(`${e.source}\u0000${e.sourceHandle}`);
    if (e.targetHandle) onPort.add(`${e.target}\u0000${e.targetHandle}`);
  }
  edges = edges.map(e => {
    const s = byId.get(e.source), t = byId.get(e.target);
    if (!s || !t) return e;
    let next = e;
    if (!e.sourceHandle && isJunction(t) && !isJunction(s)) {
      const port = bestPort(s, t, onPort);
      if (port) { next = { ...next, sourceHandle: port }; onPort.add(`${s.id}\u0000${port}`); }
    }
    if (!e.targetHandle && isJunction(s) && !isJunction(t)) {
      const port = bestPort(t, s, onPort);
      if (port) { next = { ...next, targetHandle: port }; onPort.add(`${t.id}\u0000${port}`); }
    }
    return next;
  });

  // 2026-09: tees made before they rode their pipes (September 2026) have
  // no `along`, so nothing kept them on the pipe and every face on them was
  // up for grabs. One on the single straight run its lines make through it
  // -- within the router's in-line tolerance, where it was drawn as a tee on
  // a straight pipe -- is given the record a split gives a tee today, and put
  // on its pipe. One further off sat at a bend in its lines, which somebody
  // chose, and stays a free junction.
  //
  // A tee: a run and a branch, or a click-to-branch tee, which is old for
  // certain. A junction with just two lines is also what today's canvas
  // leaves when an open end is carried on round a corner and the symbols are
  // then lined up; the canvas leaves it free -- only a gesture makes a
  // junction ride -- and adopting it here rewrote it, and moved it on the
  // next edit, only because the drawing had been saved and opened again.
  const adopted: string[] = [];
  const degree = new Map<string, number>();
  for (const e of edges) for (const id of [e.source, e.target]) degree.set(id, (degree.get(id) ?? 0) + 1);
  for (const tee of nodes) {
    if (!isJunction(tee) || junctionData(tee).along) continue;
    if ((degree.get(tee.id) ?? 0) < 3 && !clickBranched.has(tee.id)) continue;
    const r = adoptTee(nodes, edges, tee.id, portEnd);
    if (r.nodes === nodes && r.edges === edges) continue;
    nodes = r.nodes; edges = r.edges;
    adopted.push(tee.id);
  }
  if (adopted.length) ({ nodes, edges } = seatTees(nodes, edges, adopted, portEnd));

  // 2026-09: before tees rode whole pipes, each recorded the two things
  // either side of it as its `from` and `to`. Today those name the ends of
  // the pipe it rides, and a tee recording another pipe is rewritten by the
  // first reseat to touch it -- on opening, after the baseline.
  nodes = recordPipes(nodes, edges, portEnd);

  // 2026-09: the K-bottle, the dewar and a manifold with no saved layout were
  // resized so their ports sit on the 10 px grid (SupplyNode, ManifoldNode).
  // No rule here, on purpose. A saved drawing keeps a symbol's position and
  // not its size, so nothing tells a manifold placed before the change from
  // one placed after it, and moving either to make up the difference would
  // move the other wrongly on every opening. Nor is one needed: the lines on
  // a port are routed from where it is, and a tee on them stays where it was
  // on the drawing. A supply's port moved at most four pixels across its
  // line and a four-outlet manifold's at most eight; a longer block's far
  // outlets, four more for each outlet before them.

  // What nothing touched is handed back as it came, so a caller comparing
  // by identity sees only what changed.
  const unchanged = <T,>(xs: T[], was: T[]) => xs.length === was.length && xs.every((x, i) => x === was[i]);
  return { nodes: unchanged(nodes, d.nodes) ? d.nodes : nodes, edges: unchanged(edges, d.edges) ? d.edges : edges };
}

/**
 * The port of `symbol` from which a line reaches `tee` best, by the router's
 * own price: of the ports no other line is on (`taken`, by node and handle),
 * when there are any, or of them all.
 */
function bestPort(symbol: Node, tee: Node, taken: ReadonlySet<string> = new Set()): string | null {
  const c: Pt = { x: tee.position.x + 5, y: tee.position.y + 5 };
  let best: { id: string; cost: number; free: boolean } | null = null;
  for (const id of drawnPortsOf(symbol)) {
    const a: End | null = portEnd(symbol, id);
    if (!a) continue;
    const face = faceTowards(a.x, a.y, c.x, c.y) as Face;
    const cost = routeCost(pathPoints(routeOrthogonal(a, { ...junctionEnd(tee.position, face), ...J_END }).d));
    const free = !taken.has(`${symbol.id}\u0000${id}`);
    if (!best || (free && !best.free) || (free === best.free && cost < best.cost - 1e-9)) best = { id, cost, free };
  }
  return best?.id ?? null;
}
