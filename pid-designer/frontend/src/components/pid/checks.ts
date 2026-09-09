import type { Edge, Node } from '@xyflow/react';
import { propagateFluids, speciesById } from './fluids';
import { isInstrument } from './attach';
import { crossPageEdges, listPages, pageOf } from './pages';
import { findVents } from './vents';
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
  const sideOf = (n: Node) => dataOf(n).options?.side ?? 'ground';

  for (const qd of qds) {
    const paired = pairOf(qd);
    const side = sideOf(qd);

    if (paired === 'none') continue;      // declared to stand alone

    if (!paired) {
      push({
        id: `qd-unpaired-${qd.id}`,
        // A flight half with nothing to mate to is the one that strands a
        // vehicle on the pad; a ground half alone is usually just unfinished.
        severity: side === 'rocket' ? 'error' : 'info',
        title: `${nameOf(qd)} has no mating half`,
        detail: side === 'rocket'
          ? 'This is a flight half with nothing on the ground to mate with. Pick its ground half, or mark it as needing no pair.'
          : 'No mating half chosen yet. Pick one, or mark it as needing no pair.',
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

    if (sideOf(other) === side) {
      push({
        id: `qd-sameside-${qd.id}`,
        severity: 'error',
        title: `${nameOf(qd)} and ${nameOf(other)} are both ${side} halves`,
        detail: 'A pair is one flight half and one ground half. Two of the same side cannot mate, so nothing here comes apart at launch.',
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
      detail: 'A tag is the name one piece of hardware answers to on the drawing, in a run report and in a procedure. Two sharing it is two things nobody can tell apart.',
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
      detail: 'Nothing that declares a fluid reaches these, so they are not downstream of any tank yet. Set the fluid on the tanks that feed them, or join them up.',
      nodeIds: noFluid.map(n => n.id),
    });
  }

  // ── Boundary conditions a solve cannot start without ──────────────────────
  for (const n of nodes) {
    const d = dataOf(n);
    const t = d?.componentType;
    if (t === 'TANK') {
      if (!d.params?.pressure) missing(push, n, 'an operating pressure',
        'A tank is where a feed solve starts: its pressure is the boundary condition everything downstream is measured against.');
      if (!d.params?.temperature) missing(push, n, 'a propellant temperature',
        'Fluid properties are read at a temperature. Without one there is no density, and without density there is no flow.');
      if (!speciesById(d.fluid)) missing(push, n, 'a fluid',
        'Set what is in this tank and every line downstream of it inherits it.');
    }
    if (t === 'ENGINE') {
      if (!d.params?.chamber_pressure) missing(push, n, 'a chamber pressure',
        'Chamber pressure is the back pressure the whole feed system works against — the other end of the solve.');
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
      detail: 'Most of the pressure drop in a feed system is in the pipe. Double-click a line to set what it is, or name a catalogue part.',
      edgeIds: bare.map(e => e.id),
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
      detail: 'A line between pages is not drawn on either, because a reader cannot follow it. What crosses the umbilical is a disconnect pair — put a QD on each side and pair them instead.',
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
          detail: 'A disconnect pair is the boundary between the vehicle and the ground, so its two halves usually live on different pages. Worth a look if that is not what you meant.',
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
      detail: 'Crossing lines are not joined. Where two are meant to meet, click the line to drop a junction on it; where they are not, drag a line’s middle segment to route around.',
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
      detail: 'A probe carries no flow, so a solver treats it as a dead end and it makes the drawing harder to read. Delete the lines and drop it straight onto what it measures instead.',
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
      detail: `Recorded as estimated or unchecked: ${assumed.slice(0, 8).join(', ')}${assumed.length > 8 ? `, and ${assumed.length - 8} more` : ''}. Not a fault — it is the list a design review should be looking at.`,
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
    detail: `${capitalise(what)} is not set. ${why}`,
    nodeIds: [n.id],
  });
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
