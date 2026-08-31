/**
 * Diagram API (/api/pid/diagrams): the durable, server-side timeline for a
 * P&ID. An autosaved working copy, throttled microversions, and immutable named
 * releases. See backend/routers/pid.py.
 *
 * Extracted from PIDDesigner.tsx, where these were inline `fetch` calls built
 * from a `base` string. That stopped working once a diagram became addressable
 * as (owner, id): the owner rides as a `?owner=` query parameter, which cannot
 * be baked into a URL prefix that then has sub-paths appended to it.
 *
 * Plain fetch, same-origin -- the session cookie rides along, and Caddy turns it
 * into the X-Auth-Email the backend reads.
 */

import type { Node, Edge } from '@xyflow/react';

/** A diagram's geometry: what /load returns and /autosave takes. */
export type Snapshot = { nodes: Node[]; edges: Edge[] };

/** One of the user's diagrams (metadata; geometry lives in current.json). */
export interface DiagramMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Emails, as written. Absent on diagrams created before sharing existed. */
  sharedWith?: string[];
  /** Whose folder it lives in. Absent only on a response from an older server. */
  owner?: string;
  /** Display name for `owner`, falling back to the email when auth has no name. */
  ownerName?: string;
  mine?: boolean;
}

/** An automatic point-in-time snapshot in S3 (bucket-versioned). */
export interface MicroVersion {
  versionId: string;
  savedAt: string;
  size: number;
}

/** An explicit, immutable, user-named milestone. */
export interface ReleaseVersion {
  label: string;
  savedAt: string;
  size: number;
}

/** One user's diagrams in the view-only tree. */
export interface BrowseGroup {
  owner: string;
  ownerName: string;
  designs: { id: string; name: string; updatedAt: string | null }[];
}

export interface TeamUser {
  email: string;
  name: string;
}

/**
 * A diagram's address. `owner` null/undefined means "mine", which is also what
 * a server that predates sharing assumes.
 */
export interface DocRef {
  id: string;
  owner?: string | null;
}

const BASE = '/api/pid/diagrams';

/**
 * Stable identity for a diagram across renders and reloads. Not just the id:
 * two people can own diagrams with the same id, and one may be shared with you.
 */
export function keyOf(ref: { id: string; owner?: string | null }): string {
  return `${ref.owner ?? ''}/${ref.id}`;
}

/** A diagram's address from its metadata. Your own carry no owner. */
export function refOf(d: DiagramMeta): DocRef {
  return { id: d.id, owner: d.mine ? null : (d.owner ?? null) };
}

function url(ref: DocRef, suffix = ''): string {
  const q = ref.owner ? `?owner=${encodeURIComponent(ref.owner)}` : '';
  return `${BASE}/${encodeURIComponent(ref.id)}${suffix}${q}`;
}

/**
 * Carries the HTTP status, which callers need now that a request can fail for a
 * reason worth acting on: 403 means the diagram was unshared from you while you
 * had it open, and the client must stop autosaving rather than retry forever.
 */
export class ApiError extends Error {
  // A plain field, not a constructor parameter property: this project builds
  // with `erasableSyntaxOnly`, which rejects the shorthand.
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new ApiError(body.detail || `HTTP ${res.status}`, res.status);
  }
  return res.json() as Promise<T>;
}

/** Diagrams the caller may edit: their own plus anything shared with them. */
export const listDiagrams = () => fetch(BASE).then((r) => json<DiagramMeta[]>(r));

/** Everyone else's diagrams, grouped by owner -- the view-only tree. */
export const browseDiagrams = () =>
  fetch(`${BASE}/browse`).then((r) => json<BrowseGroup[]>(r));

/** Who this diagram can be shared with. Never 4xx-es on an auth outage. */
export const listUsers = () => fetch('/api/pid/users').then((r) => json<TeamUser[]>(r));

export const createDiagram = (name: string) =>
  fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then((r) => json<DiagramMeta>(r));

/**
 * Take a copy of any diagram -- yours or anyone else's -- into your own list.
 * The copy carries no history, no releases and no share list, so editing it can
 * never reach back to the original.
 */
export const copyDiagram = (ref: DocRef, name?: string) =>
  fetch(`${BASE}/copy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner: ref.owner ?? '', id: ref.id, name }),
  }).then((r) => json<DiagramMeta>(r));

export const renameDiagram = (ref: DocRef, name: string) =>
  fetch(url(ref), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then((r) => json<DiagramMeta>(r));

/** Replace the editor list wholesale (not a delta -- see the backend). */
export const shareDiagram = (ref: DocRef, sharedWith: string[]) =>
  fetch(url(ref, '/share'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sharedWith }),
  }).then((r) => json<DiagramMeta>(r));

/** Drop yourself from a diagram shared with you. Destroys nothing. */
export const leaveDiagram = (ref: DocRef) =>
  fetch(url(ref, '/share/me'), { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r));

export const loadDiagram = (ref: DocRef) => fetch(url(ref, '/load')).then((r) => json<Snapshot>(r));

export const autosaveDiagram = (ref: DocRef, data: Snapshot) =>
  fetch(url(ref, '/autosave'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then((r) => json<{ ok: boolean; micro: boolean }>(r));

/** Best-effort final snapshot on tab close. sendBeacon survives page unload. */
export const flushDiagram = (ref: DocRef, data: Snapshot): void => {
  const body = JSON.stringify(data);
  navigator.sendBeacon(url(ref, '/flush'), new Blob([body], { type: 'application/json' }));
};

export const getHistory = (ref: DocRef) =>
  fetch(url(ref, '/history')).then((r) => json<MicroVersion[]>(r));

export const getVersion = (ref: DocRef, versionId: string) =>
  fetch(url(ref, `/version/${encodeURIComponent(versionId)}`)).then((r) => json<Snapshot>(r));

export const createRelease = (ref: DocRef, label: string, data: Snapshot) =>
  fetch(url(ref, '/release'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, ...data }),
  }).then((r) => json<ReleaseVersion>(r));

export const listReleases = (ref: DocRef) =>
  fetch(url(ref, '/releases')).then((r) => json<ReleaseVersion[]>(r));

export const getRelease = (ref: DocRef, label: string) =>
  fetch(url(ref, `/release/${encodeURIComponent(label)}`)).then((r) => json<Snapshot>(r));
