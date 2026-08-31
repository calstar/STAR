/**
 * Versioned-document API (/api/engine/documents): the durable, server-side
 * timeline for a design. Mirrors the pid-designer model -- an autosaved working
 * copy, throttled microversions, and immutable named releases. See
 * backend/routers/documents.py.
 *
 * Plain fetch (same-origin, the session cookie rides along). The live editing
 * config lives in the backend session; this store adds the durable history on
 * top of it.
 *
 * A design is identified by (owner, id), not id alone: designs are shared, and
 * an editor works on the design where it lives rather than on a copy. `owner`
 * is omitted for your own designs and passed as `?owner=` for someone else's.
 * The server treats its presence as a claim to be an editor and 403s if you are
 * not one -- see backend/routers/documents.py.
 */

import type { EngineConfig } from './client';

const BASE = '/api/engine/documents';

export interface DocMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Emails, as written. Absent on designs created before sharing existed. */
  sharedWith?: string[];
  /** Whose folder it lives in. Absent only on a response from an older server. */
  owner?: string;
  /** Display name for `owner`, falling back to the email when auth has no name. */
  ownerName?: string;
  mine?: boolean;
}

/** One user's designs in the view-only tree. */
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
 * A design's address. `owner` null/undefined means "mine", which is also what a
 * server that predates sharing assumes.
 */
export interface DocRef {
  id: string;
  owner?: string | null;
}

/**
 * Stable identity for a design across renders and reloads. Not just the id:
 * two people can own designs with the same id, and one of them may be shared
 * with you.
 */
export function keyOf(ref: { id: string; owner?: string | null }): string {
  return `${ref.owner ?? ''}/${ref.id}`;
}

/** A design's address from its metadata. Your own carry no owner, so no `?owner=`. */
export function refOf(d: DocMeta): DocRef {
  return { id: d.id, owner: d.mine ? null : (d.owner ?? null) };
}

/** `?owner=` when the design is someone else's, nothing when it is your own. */
function q(owner?: string | null): string {
  return owner ? `?owner=${encodeURIComponent(owner)}` : '';
}

function url(ref: DocRef, suffix = ''): string {
  return `${BASE}/${encodeURIComponent(ref.id)}${suffix}${q(ref.owner)}`;
}

export interface MicroVersion {
  versionId: string;
  savedAt: string;
  size?: number;
}

export interface ReleaseVersion {
  label: string;
  savedAt: string;
  size?: number;
}

/**
 * Carries the HTTP status, which callers need now that a request can fail for a
 * reason worth acting on: 403 means the design was unshared from you while you
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

/** Designs the caller may edit: their own plus anything shared with them. */
export const listDocuments = () => fetch(BASE).then((r) => json<DocMeta[]>(r));

/** Everyone else's designs, grouped by owner -- the view-only tree. */
export const browseDocuments = () =>
  fetch(`${BASE}/browse`).then((r) => json<BrowseGroup[]>(r));

/** Who this design can be shared with. Never 4xx-es on an auth outage. */
export const listUsers = () => fetch('/api/engine/users').then((r) => json<TeamUser[]>(r));

export const createDocument = (name: string, config?: EngineConfig) =>
  fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, config }),
  }).then((r) => json<DocMeta>(r));

/**
 * Take a copy of any design -- yours or anyone else's -- into your own list.
 * The copy carries no history, no releases and no share list, so editing it can
 * never reach back to the original.
 */
export const copyDocument = (ref: DocRef, name?: string) =>
  fetch(`${BASE}/copy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner: ref.owner ?? '', id: ref.id, name }),
  }).then((r) => json<DocMeta>(r));

export const renameDocument = (ref: DocRef, name: string) =>
  fetch(url(ref), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then((r) => json<DocMeta>(r));

/** Replace the editor list wholesale (not a delta -- see the backend). */
export const shareDocument = (ref: DocRef, sharedWith: string[]) =>
  fetch(url(ref, '/share'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sharedWith }),
  }).then((r) => json<DocMeta>(r));

/** Drop yourself from a design shared with you. Destroys nothing. */
export const leaveDocument = (ref: DocRef) =>
  fetch(url(ref, '/share/me'), { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r));

export const loadDocument = (ref: DocRef) =>
  fetch(url(ref, '/load')).then((r) =>
    json<{ config: EngineConfig | Record<string, never> }>(r),
  );

export const autosaveDocument = (ref: DocRef, config: EngineConfig) =>
  fetch(url(ref, '/autosave'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config }),
  }).then((r) => json<{ ok: boolean; micro: boolean }>(r));

/** Best-effort final snapshot on tab close. sendBeacon survives page unload. */
export const flushDocument = (ref: DocRef, config: EngineConfig): void => {
  const body = JSON.stringify({ config });
  navigator.sendBeacon(url(ref, '/flush'), new Blob([body], { type: 'application/json' }));
};

export const getHistory = (ref: DocRef) =>
  fetch(url(ref, '/history')).then((r) => json<MicroVersion[]>(r));

export const getVersion = (ref: DocRef, versionId: string) =>
  fetch(url(ref, `/version/${encodeURIComponent(versionId)}`)).then((r) =>
    json<{ config: EngineConfig }>(r),
  );

export const createRelease = (ref: DocRef, label: string, config?: EngineConfig) =>
  fetch(url(ref, '/release'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, config }),
  }).then((r) => json<ReleaseVersion>(r));

export const listReleases = (ref: DocRef) =>
  fetch(url(ref, '/releases')).then((r) => json<ReleaseVersion[]>(r));

export const getRelease = (ref: DocRef, label: string) =>
  fetch(url(ref, `/release/${encodeURIComponent(label)}`)).then((r) =>
    json<{ config: EngineConfig }>(r),
  );
