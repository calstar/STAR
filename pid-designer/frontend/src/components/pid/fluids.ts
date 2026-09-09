/**
 * What is actually in the tanks, and what that makes every line downstream.
 *
 * The palette used to offer four things -- fuel, lox, pressurant, default --
 * which are *colours*, not fluids. "Fuel" does not tell a property layer
 * whether to look up ethanol or RP-1, and those differ by more than enough to
 * change an answer. The species below are exactly the ones
 * `feedtwin/props/species.toml` declares, under the same names, so a drawing
 * names a fluid the physics core can resolve without a translation table.
 *
 * **Fluid is declared once, at a source, and inherited.** You say ethanol is in
 * this tank and LOX is in that one; every line, valve and fitting reachable
 * from a tank without passing through another source belongs to that tank's
 * fluid. Typing it per component would be sixty entries where four will do, and
 * the sixty would drift.
 *
 * That inheritance is also a check, which is the part worth having. Two sources
 * reaching one component means fuel and oxidiser meet somewhere they should not
 * -- on a drawing that is a line drawn to the wrong port, and on the stand it is
 * the worst afternoon of your life. It is reported rather than blended.
 */

import type { Edge, Node } from '@xyflow/react';
import type { PIDNodeData } from './types';

export type SpeciesId =
  | 'oxygen' | 'ethanol' | 'nitrogen' | 'helium' | 'methane' | 'other';

export type FluidRole = 'oxidizer' | 'fuel' | 'pressurant' | 'unknown';

export interface Species {
  id: SpeciesId;
  label: string;
  role: FluidRole;
  /** How it reads on a symbol. Short — it is drawn inside a 48 px tank. */
  short: string;
}

/** Mirrors `feedtwin/props/species.toml`. Ids are what the reader resolves. */
export const SPECIES: Species[] = [
  { id: 'oxygen',   label: 'Oxygen (LOX / GOX)',   role: 'oxidizer',   short: 'LOX' },
  { id: 'ethanol',  label: 'Ethanol',              role: 'fuel',       short: 'ETH' },
  { id: 'nitrogen', label: 'Nitrogen (GN2 / LN2)', role: 'pressurant', short: 'N2'  },
  { id: 'helium',   label: 'Helium (GHe)',         role: 'pressurant', short: 'He'  },
  { id: 'methane',  label: 'Methane (LCH4)',       role: 'fuel',       short: 'CH4' },
  // Not in species.toml, and deliberately so: it is how you draw a nitrogen
  // purge of an unmodelled bay without claiming the physics core can price it.
  { id: 'other',    label: 'Other / not modelled', role: 'unknown',    short: '—'   },
];

export const speciesById = (id?: string): Species | undefined =>
  SPECIES.find(s => s.id === id);

/**
 * Colour by role, not by species: a reader is looking for "is this the ox side"
 * long before they are looking for which oxidiser.
 */
export const ROLE_COLORS: Record<FluidRole, string> = {
  oxidizer:   '#60a5fa',
  fuel:       '#f97316',
  pressurant: '#ef4444',
  unknown:    '#94a3b8',
};

export const UNSET_COLOR = '#64748b';

export function colorForSpecies(id?: string): string {
  const s = speciesById(id);
  return s ? ROLE_COLORS[s.role] : UNSET_COLOR;
}

/** What the propagation worked out for one component. */
export interface FluidAssignment {
  species: SpeciesId | null;
  /** Node ids of the sources it was inherited from. */
  sources: string[];
  /** Two fluids met somewhere they should not have. */
  conflict: boolean;
  /** Two fluids met somewhere they are supposed to — an engine, a tank ullage. */
  mixing: boolean;
}

const dataOf = (n: Node) => n.data as unknown as PIDNodeData;

/**
 * Components where two fluids legitimately meet, and past which nothing flows.
 *
 * An engine is the obvious one: fuel arrives at one port and oxidiser at the
 * other, which is the entire idea. Without this it reads as a conflict — and
 * worse, a walk that carried on through would paint the fuel side as oxidiser
 * and then report a conflict at every joint after it.
 */
const MEETING_POINTS = new Set(['ENGINE', 'INJECTOR']);

/**
 * Is this end of a line a tank's ullage port?
 *
 * A tank declares what it *contains*, and that is not what leaves every one of
 * its ports. LOX leaves the outlet; the top of the tank is where pressurant
 * arrives. Without the distinction a LOX tank pushes LOX back up its own
 * pressurant line, and the regulator feeding it comes out blue -- which is the
 * wrong answer on the most-drawn arrangement in the system.
 *
 * Keyed on the handle id rather than on screen position, so rotating a tank
 * does not change which port is which. `t`, `t1`, `t2`... are the top end; see
 * `TankNode.endPorts`.
 */
function isUllagePort(type: string | undefined, handle: string | null | undefined): boolean {
  return type === 'TANK' && !!handle && /^t\d*$/.test(handle);
}

/**
 * Assign a fluid to every component, spreading out from the ones that declare
 * one.
 *
 * Three kinds of node, and the distinction is what stops the check crying wolf:
 *
 * - **A source** declares its fluid. Nothing propagates into it or through it.
 *   A LOX tank pressurised with nitrogen is not a LOX tank with a nitrogen
 *   problem — the ullage is nitrogen and the outlet is LOX, and the tank is
 *   where those two are supposed to be separated. Treating an arriving fluid as
 *   a conflict here fired on the single most common arrangement in the system.
 * - **A meeting point** accepts any number of fluids and passes none on.
 * - **Everything else** takes the first fluid to reach it, and a second,
 *   different one is a genuine fault: a line drawn to the wrong port.
 *
 * Breadth-first from every source at once, so the first to arrive is the
 * nearest and a later arrival is a real meeting rather than walk order.
 */
export function propagateFluids(
  nodes: Node[],
  edges: Edge[],
): Map<string, FluidAssignment> {
  const out = new Map<string, FluidAssignment>();

  const typeOf = new Map(nodes.map(n => [n.id, dataOf(n)?.componentType]));

  // Adjacency in two tiers. A line leaving a tank's ullage port is only walked
  // in the second pass, so anything genuinely fed from somewhere else -- the
  // regulator on the pressurant line -- has already claimed its fluid by then.
  // A bottle whose only connection *is* its top port still gets painted, on
  // that second pass, rather than being left blank on a technicality.
  const process = new Map<string, string[]>();
  const ullage = new Map<string, string[]>();
  const link = (m: Map<string, string[]>, a: string, b: string) => {
    const list = m.get(a);
    if (list) list.push(b);
    else m.set(a, [b]);
  };
  for (const e of edges) {
    if (!e.source || !e.target) continue;
    // Undirected: a P&ID line has no arrow, and a fluid does not care which
    // end of it somebody happened to start the drag from.
    link(isUllagePort(typeOf.get(e.source), e.sourceHandle) ? ullage : process, e.source, e.target);
    link(isUllagePort(typeOf.get(e.target), e.targetHandle) ? ullage : process, e.target, e.source);
  }
  const isMeeting = (id: string) => MEETING_POINTS.has(typeOf.get(id) ?? '');

  const declared = new Set<string>();
  const queue: { id: string; species: SpeciesId; from: string }[] = [];
  for (const n of nodes) {
    const fluid = declaredFluid(dataOf(n));
    if (!fluid) continue;
    declared.add(n.id);
    out.set(n.id, { species: fluid, sources: [n.id], conflict: false, mixing: false });
    queue.push({ id: n.id, species: fluid, from: n.id });
  }

  /**
   * @param fillOnly Assign only where nothing is known yet, and never raise a
   *   conflict. The ullage pass is a fallback for ports the first pass
   *   deliberately skipped, not a second opinion about them: without this it
   *   walks a tank's top port anyway and reports the regulator on its own
   *   pressurant line as a fluid conflict — undoing the pass's whole purpose.
   */
  const walk = (adjacency: Map<string, string[]>, work: typeof queue, fillOnly = false) => {
  while (work.length) {
    const cur = work.shift()!;
    // Nothing continues past a meeting point.
    if (cur.id !== cur.from && isMeeting(cur.id)) continue;

    for (const next of adjacency.get(cur.id) ?? []) {
      // A source holds its own fluid. Whatever arrives at it is expected.
      if (declared.has(next)) {
        if (fillOnly) continue;
        const src = out.get(next)!;
        if (src.species !== cur.species) {
          src.mixing = true;
          if (!src.sources.includes(cur.from)) src.sources.push(cur.from);
        }
        continue;
      }

      const seen = out.get(next);
      if (!seen) {
        out.set(next, { species: cur.species, sources: [cur.from], conflict: false, mixing: false });
        work.push({ id: next, species: cur.species, from: cur.from });
        continue;
      }
      if (fillOnly) continue;
      if (seen.species === cur.species) {
        if (!seen.sources.includes(cur.from)) seen.sources.push(cur.from);
        continue;
      }
      // Two fluids, one component. Fine at a meeting point, a fault anywhere
      // else -- and either way the walk stops, because past here it is a guess.
      if (isMeeting(next)) seen.mixing = true;
      else seen.conflict = true;
      if (!seen.sources.includes(cur.from)) seen.sources.push(cur.from);
    }
  }
  };

  walk(process, [...queue]);
  // Second pass: ullage ports, seeded from the sources again so a bottle
  // connected only by its top is still the source of its own contents. Fill
  // only -- see `walk`.
  walk(ullage, [...queue], true);

  return out;
}

/**
 * The fluid in a line: its endpoints' fluid, when they agree.
 *
 * A line whose ends disagree is drawn as the conflict, not as one of the two,
 * because a pipe carrying two different fluids is the drawing being wrong.
 */
export function edgeFluid(
  edge: Edge,
  byNode: Map<string, FluidAssignment>,
): FluidAssignment {
  const a = byNode.get(edge.source);
  const b = byNode.get(edge.target);
  if (!a && !b) return { species: null, sources: [], conflict: false, mixing: false };
  if (!a || !b) {
    const one = (a ?? b)!;
    return { ...one, sources: [...one.sources] };
  }
  if (a.species !== b.species) {
    // A line into a meeting point legitimately differs from what is already
    // there -- the fuel line into an engine is not the oxidiser line.
    const meeting = b.mixing || a.mixing;
    return {
      species: a.species,
      sources: [...new Set([...a.sources, ...b.sources])],
      conflict: !meeting,
      mixing: meeting,
    };
  }
  return {
    species: a.species,
    sources: [...new Set([...a.sources, ...b.sources])],
    conflict: a.conflict || b.conflict,
    mixing: a.mixing || b.mixing,
  };
}

/**
 * Read a node's declared fluid, migrating the four colour categories that came
 * before it.
 *
 * `fluidType` was `fuel | lox | pressurant | default` -- a colour, chosen from
 * a list with no ethanol in it. Existing drawings are full of them, so they
 * are read as the species they almost certainly meant rather than dropped.
 * `fuel` becomes ethanol because that is what this vehicle burns; anyone
 * flying something else re-picks it once, and sees the species named on the
 * symbol either way.
 */
const LEGACY_FLUIDS: Record<string, SpeciesId> = {
  lox: 'oxygen',
  fuel: 'ethanol',
  pressurant: 'nitrogen',
};

export function declaredFluid(data: PIDNodeData | undefined): SpeciesId | undefined {
  if (!data) return undefined;
  if (data.fluid) return data.fluid as SpeciesId;
  return data.fluidType ? LEGACY_FLUIDS[data.fluidType] : undefined;
}
