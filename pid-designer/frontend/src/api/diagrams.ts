/**
 * The diagram API, bound to this app.
 *
 * The transport, the sharing model and the `(owner, id)` addressing all live in
 * `@stardesign-ui` -- shared with EngineDesign and recovery-calculator,
 * mirroring the shared server router. What is app-specific is only what is
 * below: the route prefix and the payload, which here is a graph rather than a
 * config blob.
 */

import { createDesignApi } from '@stardesign-ui';
import type { DesignMeta, DocRef } from '@stardesign-ui';
import type { Node, Edge } from '@xyflow/react';

export { keyOf, refOf, ApiError } from '@stardesign-ui';
export type {
  BrowseGroup,
  DocRef,
  MicroVersion,
  ReleaseVersion,
  TeamUser,
} from '@stardesign-ui';

/** A diagram's geometry: what /load returns and /autosave takes. */
export type Snapshot = { nodes: Node[]; edges: Edge[] };

/** Named `DiagramMeta` throughout this app; the shape is the shared one. */
export type DiagramMeta = DesignMeta;

/**
 * The diagram as it should be stored: authored content only.
 *
 * ReactFlow decorates every node with view state that has nothing to do with
 * the diagram -- `selected` flips on a plain click, `dragging` is a transient
 * flag, and `measured` is a post-layout measurement it recomputes on load.
 * Saved verbatim (which is what used to happen), those meant that *looking* at
 * a diagram rewrote it: a click produced a new payload, which the autosave
 * debounce dutifully persisted, and version history filled with snapshots whose
 * only difference was which node someone had highlighted. One committed
 * microversion in this repo is exactly that.
 *
 * Exported because the canvas also compares against it to decide whether
 * anything worth saving actually changed.
 */
export function toStored(data: Snapshot): Snapshot {
  return {
    nodes: data.nodes.map(({ selected: _s, dragging: _d, measured: _m, ...node }) => node) as Node[],
    edges: data.edges.map(({ selected: _s, ...edge }) => edge) as Edge[],
  };
}

const api = createDesignApi<Snapshot>({
  base: '/api/pid/diagrams',
  usersPath: '/api/pid/users',
  codec: {
    // The strip lives here so every write path gets it -- autosave, the
    // on-close beacon and a release -- and none of them can drift apart.
    toBody: (snap) => toStored(snap) as unknown as Record<string, unknown>,
    fromBody: (body) => {
      const b = (body ?? {}) as Partial<Snapshot>;
      return { nodes: b.nodes ?? [], edges: b.edges ?? [] };
    },
    empty: () => ({ nodes: [], edges: [] }),
  },
});

/** The whole API object, for shared components that take it as a prop. */
export const designApi = api;

// Named exports, so the call sites read the same as before the extraction.
export const listDiagrams = api.list;
export const browseDiagrams = api.browse;
export const listUsers = api.listUsers;
export const createDiagram = (name: string) => api.create(name);
export const copyDiagram = (ref: DocRef, name?: string) => api.copy(ref, name);
export const renameDiagram = api.rename;
export const shareDiagram = api.share;
export const leaveDiagram = api.leave;
export const loadDiagram = api.load;
export const autosaveDiagram = api.autosave;
export const flushDiagram = api.flush;
export const getHistory = api.getHistory;
export const listReleases = api.listReleases;
export const getVersion = api.getVersion;
export const getRelease = api.getRelease;
export const createRelease = (ref: DocRef, label: string, data: Snapshot) =>
  api.createRelease(ref, label, data);
