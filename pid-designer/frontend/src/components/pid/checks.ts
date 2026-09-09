import type { Edge, Node } from '@xyflow/react';
import { propagateFluids, speciesById } from './fluids';
import { isInstrument } from './attach';
import { crossPageEdges, listPages, pageOf } from './pages';
import { findVents } from './vents';
import { portsOf, portIsDrawn } from './ports';
import type { PIDNodeData, PIDEdgeData } from './types';

/**
 * What is wrong with this feed system.
 *
 * The rule for what belongs here: a check earns its place by catching
 * something that is expensive to find later and cheap to see now. A rocket-side
 * disconnect with no ground half is a fill line nobody can disconnect, and it
 * is invisible on a drawing until somebody is standing at the pad.
 *
 * The rule for what does *not*: anything that fires on a correct drawing. A
 * check people learn to dismiss is worse than no check, because it trains them
 * past the ones that matter. That is why the fluid rules distinguish a tank
 * ullage from a mixing fault, and why an incomplete drawing produces `info`
 * rather than a wall of red -- most drawings are incomplete most of the time,
 * and that is not an error, it is Tuesday.
 */

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  id: string;
  severity: Severity;
  /** Short, and says what is wrong rather than what rule fired. */
  title: string;
  detail: string;
  /** What to select when somebody clicks the finding. */
  nodeIds?: string[];
  edgeIds?: string[];
}

const dataOf = (n: Node) => n.data as unknown as PIDNodeData;
const edgeDataOf = (e: Edge) => (e.data ?? {}) as unknown as PIDEdgeData;
const nameOf = (n: Node) => dataOf(n)?.label || n.id;

export function runChecks(nodes: Node[], edges: Edge[]): Finding[] {
  const found: Finding[] = [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const push = (f: Finding) => found.push(f);

  // ── Quick disconnects ─────────────────────────────────────────────────────
  const qds = nodes.filter(n => dataOf(n)?.componentType === 'QD');
  const pairOf = (n: Node) => dataOf(n).options?.pairedWith ?? '';
  const serviceOf = (n: Node) => dataOf(n).options?.service ?? 'fluid';

  for (const qd of qds) {
    const paired = pairOf(qd);

    if (paired === 'none') continue;      // declared to stand alone

    if (!paired) {
      push({
        id: `qd-unpaired-${qd.id}`,
        severity: 'info',
        title: `${nameOf(qd)} has no mating half`,
        detail: 'Pick the disconnect on the other side, or mark it as needing no pair.',
        nodeIds: [qd.id],
      });
      continue;
    }

    const other = byId.get(paired);
    if (!other) {
      push({
        id: `qd-missing-${qd.id}`,
        severity: 'error',
        title: `${nameOf(qd)} is paired with something that is gone`,
        detail: 'The disconnect it mates with has been deleted. Pick another, or mark it as needing no pair.',
        nodeIds: [qd.id],
      });
      continue;
    }

    if (serviceOf(other) !== serviceOf(qd)) {
      push({
        id: `qd-service-${qd.id}`,
        severity: 'error',
        title: `${nameOf(qd)} and ${nameOf(other)} are different types`,
        detail: 'A hydraulic disconnect does not mate with a fluid one.',
        nodeIds: [qd.id, other.id],
      });
    }

    const back = pairOf(other);
    if (back && back !== qd.id) {
      push({
        id: `qd-asym-${qd.id}`,
        severity: 'warning',
        title: `${nameOf(qd)} and ${nameOf(other)} disagree about who they mate with`,
        detail: `${nameOf(qd)} is set to mate with ${nameOf(other)}, but ${nameOf(other)} is set to mate with something else. One of the two is wrong.`,
        nodeIds: [qd.id, other.id],
      });
    }
  }

  // ── Tags ──────────────────────────────────────────────────────────────────
  // `feedtwin.solve.Node` documents its id as "the tags on the P&ID", so a tag
  // is not a caption -- it is the name a solver, a run report and a procedure
  // all use for one piece of hardware. Two components answering to it is two
  // things a reader cannot tell apart, and the drawing is where that is cheap
  // to notice.
  const byTag = new Map<string, Node[]>();
  for (const n of nodes) {
    const t = dataOf(n)?.componentType;
    if (!t || t === 'TEXT' || t === 'REGION' || t === 'JUNCTION') continue;
    const tag = (dataOf(n)?.label ?? '').trim();
    if (!tag) continue;
    const list = byTag.get(tag);
    if (list) list.push(n);
    else byTag.set(tag, [n]);
  }
  for (const [tag, sharing] of byTag) {
    if (sharing.length < 2) continue;
    push({
      id: `tag-duplicate-${tag}`,
      severity: 'warning',
      title: `${sharing.length} components are all tagged ${tag}`,
      detail: 'Rename one. A solve, a report and a procedure all key on the tag.',
      nodeIds: sharing.map(n => n.id),
    });
  }

  const untagged = nodes.filter(n => {
    const t = dataOf(n)?.componentType;
    if (!t || t === 'TEXT' || t === 'REGION' || t === 'JUNCTION') return false;
    return !(dataOf(n)?.label ?? '').trim();
  });
  if (untagged.length) {
    push({
      id: 'tags-missing',
      severity: 'info',
      title: `${untagged.length} component${untagged.length === 1 ? '' : 's'} with no tag`,
      detail: 'Give each one a name. It is what a solve, a report and a procedure will call it.',
      nodeIds: untagged.map(n => n.id),
    });
  }

  // ── Fluids ────────────────────────────────────────────────────────────────
  const fluids = propagateFluids(nodes, edges);

  for (const n of nodes) {
    const f = fluids.get(n.id);
    if (f?.conflict) {
      const names = f.sources.map(s => nameOf(byId.get(s) ?? ({ id: s, data: {} } as Node)));
      push({
        id: `fluid-conflict-${n.id}`,
        severity: 'error',
        title: `Two fluids reach ${nameOf(n)}`,
        detail: `Fed from ${names.join(' and ')}. On a drawing that is a line run to the wrong port; on the stand it is fuel and oxidiser meeting somewhere they should not.`,
        nodeIds: [n.id, ...f.sources],
      });
    }
  }

  const noFluid = nodes.filter(n => {
    const t = dataOf(n)?.componentType;
    // Annotation is not plumbing: a section box has no fluid in it.
    if (!t || t === 'TEXT' || t === 'REGION' || t === 'JUNCTION' || isInstrument(t)) return false;
    return !fluids.get(n.id)?.species;
  });
  if (noFluid.length) {
    push({
      id: 'fluid-unassigned',
      severity: 'info',
      title: `${noFluid.length} component${noFluid.length === 1 ? '' : 's'} with no fluid`,
      detail: 'Nothing that declares a fluid reaches them. Set it on the tank that feeds them, or join them up.',
      nodeIds: noFluid.map(n => n.id),
    });
  }

  // ── Boundary conditions a solve cannot start without ──────────────────────
  for (const n of nodes) {
    const d = dataOf(n);
    const t = d?.componentType;
    if (t === 'TANK') {
      if (!d.params?.pressure) missing(push, n, 'an operating pressure',
        'A solve starts here; without it there is no boundary condition.');
      if (!d.params?.temperature) missing(push, n, 'a propellant temperature',
        'No temperature, no density, no flow.');
      if (!speciesById(d.fluid)) missing(push, n, 'a fluid',
        'Set it here and every line downstream inherits it.');
    }
    if (t === 'ENGINE') {
      if (!d.params?.chamber_pressure) missing(push, n, 'a chamber pressure',
        'It is the back pressure the whole feed works against.');
    }
  }

  // ── Lines ─────────────────────────────────────────────────────────────────
  const bare = edges.filter(e => {
    const d = edgeDataOf(e);
    return !d.partNumber && !(d.params?.length && d.params?.bore);
  });
  if (bare.length) {
    push({
      id: 'lines-unsized',
      severity: 'info',
      title: `${bare.length} line${bare.length === 1 ? '' : 's'} with no length or bore`,
      detail: 'Double-click a line to set what it is. Most of a feed system’s pressure drop is in the pipe.',
      edgeIds: bare.map(e => e.id),
    });
  }

  // A line attached to a port that no longer exists is the invisible-edge
  // failure again: React Flow cannot place it, so it is saved and never drawn.
  // It happens by reducing a port count, or by plugging a port that had a line
  // on it -- both of which look harmless at the time.
  const orphaned: Edge[] = [];
  for (const e of edges) {
    for (const [nodeId, handle] of [[e.source, e.sourceHandle], [e.target, e.targetHandle]] as const) {
      const n = nodeId ? byId.get(nodeId) : undefined;
      if (!n || !handle) continue;
      const available = portsOf(n);
      if (available.length === 0) continue;      // nothing declared; nothing to check
      if (!available.includes(handle) || !portIsDrawn(dataOf(n), handle)) {
        orphaned.push(e);
        break;
      }
    }
  }
  if (orphaned.length) {
    push({
      id: 'lines-orphaned-port',
      severity: 'error',
      title: `${orphaned.length} line${orphaned.length === 1 ? '' : 's'} attached to a port that is gone`,
      detail: 'Saved but not drawable: the port went away after the line did. Re-attach it, or put the port back.',
      edgeIds: orphaned.map(e => e.id),
    });
  }

  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) {
      push({
        id: `line-dangling-${e.id}`,
        severity: 'warning',
        title: 'A line hangs off nothing',
        detail: 'One end of this line points at a component that is no longer on the drawing.',
        edgeIds: [e.id],
      });
    }
  }

  // ── Pages ─────────────────────────────────────────────────────────────────
  const crossing = crossPageEdges(nodes, edges);
  if (crossing.length) {
    push({
      id: 'lines-cross-pages',
      severity: 'warning',
      title: `${crossing.length} line${crossing.length === 1 ? '' : 's'} run between pages`,
      detail: 'Neither page draws it. Put a QD on each side and pair them — that is what crosses an umbilical.',
      edgeIds: crossing.map(e => e.id),
    });
  }

  const pages = listPages(nodes);
  if (pages.length > 1) {
    for (const qd of qds) {
      const paired = pairOf(qd);
      const other = paired && paired !== 'none' ? byId.get(paired) : undefined;
      if (!other) continue;
      if (pageOf(dataOf(qd)) === pageOf(dataOf(other))) {
        push({
          id: `qd-samepage-${qd.id}`,
          severity: 'info',
          title: `${nameOf(qd)} and ${nameOf(other)} are on the same page`,
          detail: 'Usually right — a pair is the vehicle/ground boundary. Worth a look if it is not what you meant.',
          nodeIds: [qd.id, other.id],
        });
      }
    }
  }

  // ── Vents ─────────────────────────────────────────────────────────────────
  // Read off the drawing rather than declared, so this is a note saying what
  // was inferred -- the point is that it is visible, not that it is a problem.
  const vents = findVents(nodes, edges);
  if (vents.length) {
    const named = vents.map(v => nameOf(byId.get(v.nodeId)!)).slice(0, 8).join(', ');
    push({
      id: 'vents-inferred',
      severity: 'info',
      title: `${vents.length} valve${vents.length === 1 ? '' : 's'} read as venting to atmosphere`,
      detail: `${named}${vents.length > 8 ? `, and ${vents.length - 8} more` : ''} — each is connected on one side only, so a solve will treat the open side as ambient. Plumb the far side if that is not what it is.`,
      nodeIds: vents.map(v => v.nodeId),
    });
  }

  // ── Lines that cross ──────────────────────────────────────────────────────
  // Two paths overlapping is not a connection, and nothing in this tool infers
  // one -- a crossing is usually one line passing over another, and guessing
  // wrong either invents a leak path or hides a real one. Saying how many there
  // are makes the distinction visible instead of leaving people to assume it
  // one way or the other.
  const crossings = countCrossings(nodes, edges);
  if (crossings > 0) {
    push({
      id: 'lines-crossing',
      severity: 'info',
      title: `${crossings} place${crossings === 1 ? '' : 's'} where lines cross`,
      detail: 'Crossing is not joining. To join them, drag one onto the other; to keep them apart, drag a line’s middle segment.',
    });
  }

  // ── Instruments ───────────────────────────────────────────────────────────
  const wired = nodes.filter(n => {
    if (!isInstrument(dataOf(n)?.componentType)) return false;
    if (dataOf(n).attachedTo) return false;
    return edges.some(e => e.source === n.id || e.target === n.id);
  });
  if (wired.length) {
    push({
      id: 'instruments-wired',
      severity: 'warning',
      title: `${wired.length} instrument${wired.length === 1 ? '' : 's'} wired into the flow path`,
      detail: 'Delete the lines and drop it straight onto what it measures — a probe carries no flow.',
      nodeIds: wired.map(n => n.id),
    });
  }

  const floating = nodes.filter(n =>
    isInstrument(dataOf(n)?.componentType) &&
    !dataOf(n).attachedTo &&
    !edges.some(e => e.source === n.id || e.target === n.id));
  if (floating.length) {
    push({
      id: 'instruments-floating',
      severity: 'info',
      title: `${floating.length} instrument${floating.length === 1 ? '' : 's'} not measuring anything`,
      detail: 'Drag each onto the component or line it reads, and it will clip to it.',
      nodeIds: floating.map(n => n.id),
    });
  }

  // ── Numbers nobody has checked ────────────────────────────────────────────
  const assumed: string[] = [];
  for (const n of nodes) {
    const params = dataOf(n)?.params ?? {};
    for (const [key, p] of Object.entries(params)) {
      if (p.source === 'default' || p.source === 'estimated') {
        assumed.push(`${nameOf(n)}.${key}`);
      }
    }
  }
  if (assumed.length) {
    push({
      id: 'params-assumed',
      severity: 'info',
      title: `${assumed.length} value${assumed.length === 1 ? '' : 's'} nobody has established`,
      detail: `${assumed.slice(0, 8).join(', ')}${assumed.length > 8 ? `, and ${assumed.length - 8} more` : ''} — the list a design review should be looking at.`,
    });
  }

  return found.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function missing(push: (f: Finding) => void, n: Node, what: string, why: string) {
  push({
    id: `missing-${n.id}-${what.replace(/\s+/g, '-')}`,
    severity: 'warning',
    title: `${nameOf(n)} has no ${what.replace(/^an? /, '')}`,
    // Just the reason. It used to open with "<what> is not set", which is
    // what the title above it already says -- and a panel that says everything
    // twice is one people stop reading.
    detail: why,
    nodeIds: [n.id],
  });
}

/** What the badge shows: things that are actually wrong. */
export const countProblems = (findings: Finding[]) =>
  findings.filter(f => f.severity !== 'info').length;

/**
 * How many pairs of lines cross without sharing a component.
 *
 * Straight segments between component centres, which is not the drawn
 * orthogonal path -- so this is an indication, not a survey. It answers "does
 * this drawing have crossings in it", which is the question, and it never
 * claims two lines are joined.
 */
function countCrossings(nodes: Node[], edges: Edge[]): number {
  const centre = (id: string) => {
    const n = nodes.find(x => x.id === id);
    if (!n) return null;
    return {
      x: n.position.x + (n.measured?.width ?? 60) / 2,
      y: n.position.y + (n.measured?.height ?? 60) / 2,
    };
  };
  const segments = edges
    .map(e => ({ e, a: centre(e.source), b: centre(e.target) }))
    .filter((s): s is { e: Edge; a: { x: number; y: number }; b: { x: number; y: number } } =>
      !!s.a && !!s.b);

  let n = 0;
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const p = segments[i];
      const q = segments[j];
      // Lines meeting at a shared component are joined, not crossing.
      const shared = new Set([p.e.source, p.e.target]);
      if (shared.has(q.e.source) || shared.has(q.e.target)) continue;
      if (segmentsCross(p.a, p.b, q.a, q.b)) n++;
    }
  }
  return n;
}

type Pt = { x: number; y: number };
const side = (a: Pt, b: Pt, c: Pt) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = side(a, b, c);
  const d2 = side(a, b, d);
  const d3 = side(c, d, a);
  const d4 = side(c, d, b);
  // Strict: touching endpoints are not a crossing.
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
