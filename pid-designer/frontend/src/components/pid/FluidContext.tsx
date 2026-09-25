import { createContext, useContext, useLayoutEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Edge, Node } from '@xyflow/react';
import { propagateFluids, edgeFluid, colorForSpecies, UNSET_COLOR } from './fluids';
import type { FluidAssignment } from './fluids';
import { instrumentTaps } from './ports';

/**
 * Which fluid is in what, published once for every symbol to read.
 *
 * This is **derived**, and deliberately never written back into node data.
 * What a line carries is a fact about the graph -- change which tank feeds it
 * and the answer changes -- so storing it would create a second copy that goes
 * stale the moment somebody moves an edge, and the stale copy is the one a
 * reader would trust. Only the *declaration* on a source is saved.
 *
 * A context rather than props because the node renderers are reached through
 * React Flow's `nodeTypes`, which passes them nothing of ours -- the same
 * reason `ReadOnlyProvider` exists.
 *
 * **Read one id at a time.** The map is worked out again on every change to
 * the drawing, a drag tick included, and it used to be the context's value:
 * a new map every tick, so every line, tee and port in the drawing re-rendered
 * on every tick to read a colour that had not changed. The context now holds
 * a store that never changes identity, and each reader subscribes to its own
 * entry, so the only things that re-render are the ones whose fluid did.
 */

interface FluidMap {
  byNode: Map<string, FluidAssignment>;
  byEdge: Map<string, FluidAssignment>;
  /** Ports that are instrument tappings, by `"<node>:<port>"`. Derived from
   *  what is connected to them -- see `instrumentTaps`. */
  taps: Set<string>;
}

const EMPTY: FluidMap = { byNode: new Map(), byEdge: new Map(), taps: new Set() };

const sameAssignment = (a: FluidAssignment, b: FluidAssignment) =>
  a.species === b.species && a.conflict === b.conflict && a.mixing === b.mixing &&
  a.sources.length === b.sources.length && a.sources.every((s, i) => s === b.sources[i]);

/**
 * `next`, with every entry equal to the one before handed back as the object
 * before. Then "did this reader's fluid change" is an identity test, and a
 * reader that re-renders for its own reasons still gets the same object.
 */
function keepUnchanged(prev: Map<string, FluidAssignment>, next: Map<string, FluidAssignment>) {
  for (const [id, a] of next) {
    const old = prev.get(id);
    if (old && old !== a && sameAssignment(old, a)) next.set(id, old);
  }
}

type Read<T> = (m: FluidMap) => T;

/** The current map, and who to tell when one entry of it changes. */
export class FluidStore {
  current: FluidMap = EMPTY;
  private readonly readers = new Map<string, { read: Read<unknown>; wake: Set<() => void> }>();

  /** Listen to one entry; `key` names it, `read` fetches it from a map. */
  subscribe<T>(key: string, read: Read<T>, wake: () => void): () => void {
    let entry = this.readers.get(key);
    if (!entry) { entry = { read, wake: new Set() }; this.readers.set(key, entry); }
    entry.wake.add(wake);
    return () => {
      const e = this.readers.get(key);
      if (!e) return;
      e.wake.delete(wake);
      if (e.wake.size === 0) this.readers.delete(key);
    };
  }

  /** Swap in a new map and wake the readers whose entry changed. */
  publish(next: FluidMap): void {
    const prev = this.current;
    if (next === prev) return;
    keepUnchanged(prev.byNode, next.byNode);
    keepUnchanged(prev.byEdge, next.byEdge);
    this.current = next;
    for (const { read, wake } of [...this.readers.values()]) {
      if (read(prev) !== read(next)) for (const w of [...wake]) w();
    }
  }
}

const FluidContext = createContext<FluidStore>(new FluidStore());

export function FluidProvider({ nodes, edges, children }: {
  nodes: Node[]; edges: Edge[]; children: ReactNode;
}) {
  const [store] = useState(() => new FluidStore());
  const next = useMemo<FluidMap>(() => {
    const byNode = propagateFluids(nodes, edges);
    const typeOf = new Map(nodes.map(n =>
      [n.id, (n.data as { componentType?: string } | undefined)?.componentType]));
    const byEdge = new Map(edges.map(e => [e.id, edgeFluid(e, byNode, typeOf)]));
    return { byNode, byEdge, taps: instrumentTaps(nodes, edges) };
  }, [nodes, edges]);

  // Before paint, and after the readers below have subscribed: a layout effect
  // runs children first, so a reader mounted in this commit is listening by
  // the time the map it has not seen yet arrives.
  useLayoutEffect(() => { store.publish(next); }, [store, next]);

  return <FluidContext.Provider value={store}>{children}</FluidContext.Provider>;
}

/** One entry of the map, re-rendering the caller only when that entry changes. */
function useEntry<T>(key: string, read: Read<T>): T {
  const store = useContext(FluidContext);
  const [, wake] = useState(0);
  useLayoutEffect(
    () => store.subscribe(key, read, () => wake(n => n + 1)),
    // `read` is derived from `key` at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, key],
  );
  return read(store.current);
}

/** Is this port an instrument tapping? True when everything on it is one. */
export function useIsTap(nodeId: string, portId: string): boolean {
  const key = `${nodeId}:${portId}`;
  return useEntry(`tap:${key}`, m => m.taps.has(key));
}

/** What this component ended up carrying, declared or inherited. */
export function useNodeFluid(id: string): FluidAssignment | undefined {
  return useEntry(`node:${id}`, m => m.byNode.get(id));
}

export function useEdgeFluidColor(id: string, override?: string): string {
  const f = useEntry(`edge:${id}`, m => m.byEdge.get(id));
  if (override) return override;
  if (f?.conflict) return CONFLICT_COLOR;
  return f?.species ? colorForSpecies(f.species) : UNSET_COLOR;
}

/** Two fluids meeting. Loud on purpose -- the shared danger token, not its
 *  own hardcoded red. */
export const CONFLICT_COLOR = 'var(--color-danger)';
