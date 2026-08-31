/**
 * The design-document API, once, for all three design tools.
 *
 * The server half of this is already shared (`lib/stardesign`), and the three
 * apps differ there in exactly four things: the route prefix, the payload
 * shape, the noun, and the `<app>` path segment. The client differs in the same
 * way, so it is parameterised the same way -- `createDesignApi` here is the
 * mirror of `DesignStore` on the backend.
 *
 * A design is addressed by `(owner, id)`, not `id` alone: designs are shared,
 * and an editor works on the design *where it lives* rather than on a copy.
 * `owner` is omitted for your own and sent as `?owner=` for someone else's; the
 * server reads its presence as a claim to be an editor and 403s if you are not
 * one.
 *
 * Plain fetch, same-origin -- the session cookie rides along, and Caddy turns
 * it into the `X-Auth-Email` the backend reads.
 */

/** Metadata for one design. The payload itself is fetched separately. */
export interface DesignMeta {
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
 * A design's address. `owner` null/undefined means "mine", which is also what a
 * server predating sharing assumes.
 */
export interface DocRef {
  id: string;
  owner?: string | null;
}

/**
 * Stable identity for a design across renders and reloads. Not just the id: two
 * people can own designs with the same id -- "Design 1" is everyone's default --
 * and one of them may be shared with you.
 */
export function keyOf(ref: { id: string; owner?: string | null }): string {
  return `${ref.owner ?? ''}/${ref.id}`;
}

/** A design's address from its metadata. Your own carry no owner, so no `?owner=`. */
export function refOf(d: DesignMeta): DocRef {
  return { id: d.id, owner: d.mine ? null : (d.owner ?? null) };
}

/**
 * Carries the HTTP status, which callers need because some failures are worth
 * acting on rather than retrying: 403 means the design was unshared from you
 * while you had it open.
 */
export class ApiError extends Error {
  // A plain field, not a constructor parameter property: these projects build
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

/**
 * How one app's payload crosses the wire.
 *
 * This is the whole of the difference between the three: EngineDesign and
 * recovery-calculator send `{config: ...}`, pid-designer sends
 * `{nodes, edges}`. `toBody` is also where a payload is narrowed to authored
 * content -- pid-designer strips the view state ReactFlow hangs off every node,
 * so that merely selecting one does not rewrite the diagram.
 */
export interface PayloadCodec<T> {
  toBody(payload: T): Record<string, unknown>;
  fromBody(body: unknown): T;
  /** An empty design, for a working copy that does not exist yet. */
  empty(): T;
}

export interface DesignApiConfig<T> {
  /** e.g. `/api/engine/documents` */
  base: string;
  /** e.g. `/api/engine/users` */
  usersPath: string;
  codec: PayloadCodec<T>;
}

export function createDesignApi<T>({ base, usersPath, codec }: DesignApiConfig<T>) {
  const q = (owner?: string | null) => (owner ? `?owner=${encodeURIComponent(owner)}` : '');
  const url = (ref: DocRef, suffix = '') =>
    `${base}/${encodeURIComponent(ref.id)}${suffix}${q(ref.owner)}`;
  const post = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return {
    /** Designs the caller may edit: their own plus anything shared with them. */
    list: () => fetch(base).then((r) => json<DesignMeta[]>(r)),

    /** Everyone else's designs, grouped by owner -- the view-only tree. */
    browse: () => fetch(`${base}/browse`).then((r) => json<BrowseGroup[]>(r)),

    /** Who a design can be shared with. Never 4xx-es on an auth outage. */
    listUsers: () => fetch(usersPath).then((r) => json<TeamUser[]>(r)),

    create: (name: string, payload?: T) =>
      fetch(base, post({ name, ...(payload ? codec.toBody(payload) : {}) })).then((r) =>
        json<DesignMeta>(r),
      ),

    /**
     * Take a copy of any design -- yours or anyone else's -- into your own list.
     * The copy carries no history, no releases and no share list, so editing it
     * can never reach back to the original.
     */
    copy: (ref: DocRef, name?: string) =>
      fetch(`${base}/copy`, post({ owner: ref.owner ?? '', id: ref.id, name })).then((r) =>
        json<DesignMeta>(r),
      ),

    rename: (ref: DocRef, name: string) =>
      fetch(url(ref), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }).then((r) => json<DesignMeta>(r)),

    /** Replace the editor list wholesale (not a delta -- see the backend). */
    share: (ref: DocRef, sharedWith: string[]) =>
      fetch(url(ref, '/share'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sharedWith }),
      }).then((r) => json<DesignMeta>(r)),

    /** Drop yourself from a design shared with you. Destroys nothing. */
    leave: (ref: DocRef) =>
      fetch(url(ref, '/share/me'), { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),

    load: (ref: DocRef) =>
      fetch(url(ref, '/load'))
        .then((r) => json<unknown>(r))
        .then((body) => codec.fromBody(body)),

    autosave: (ref: DocRef, payload: T) =>
      fetch(url(ref, '/autosave'), post(codec.toBody(payload))).then((r) =>
        json<{ ok: boolean; micro: boolean }>(r),
      ),

    /** Best-effort final snapshot on tab close. sendBeacon survives page unload. */
    flush: (ref: DocRef, payload: T): void => {
      const body = JSON.stringify(codec.toBody(payload));
      navigator.sendBeacon(url(ref, '/flush'), new Blob([body], { type: 'application/json' }));
    },

    getHistory: (ref: DocRef) => fetch(url(ref, '/history')).then((r) => json<MicroVersion[]>(r)),

    getVersion: (ref: DocRef, versionId: string) =>
      fetch(url(ref, `/version/${encodeURIComponent(versionId)}`))
        .then((r) => json<unknown>(r))
        .then((body) => codec.fromBody(body)),

    createRelease: (ref: DocRef, label: string, payload?: T) =>
      fetch(url(ref, '/release'), post({ label, ...(payload ? codec.toBody(payload) : {}) })).then(
        (r) => json<ReleaseVersion>(r),
      ),

    listReleases: (ref: DocRef) =>
      fetch(url(ref, '/releases')).then((r) => json<ReleaseVersion[]>(r)),

    getRelease: (ref: DocRef, label: string) =>
      fetch(url(ref, `/release/${encodeURIComponent(label)}`))
        .then((r) => json<unknown>(r))
        .then((body) => codec.fromBody(body)),
  };
}

export type DesignApi<T> = ReturnType<typeof createDesignApi<T>>;
