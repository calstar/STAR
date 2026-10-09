// Onshape REST calls used by the hub. Every endpoint and body here was checked
// against the v17 OpenAPI spec (https://cad.onshape.com/glassworks/explorer).
//
// Two kinds of credentials:
//  - the service account's API keys (HMAC-signed requests) for everything that
//    touches the library document;
//  - a panel user's OAuth access token for inserting into *their* assembly.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from '../config.ts';

const API = '/api/v17';
const JSON_ACCEPT = 'application/json;charset=UTF-8; qs=0.09';
// Isometric view: rows map model x/y/z to view x (right), y (up), z (towards viewer).
// Onshape's standard "Name" property: the same id for every part in every document.
const NAME_PROPERTY = '57f3fb8efa3416c06701d60d';
// Onshape's standard "Mass" property; setting it overrides the computed mass (vendor STEP
// files have no material, so Onshape can't compute one).
const MASS_PROPERTY = '57f3fb8efa3416c06701d626';
export const massValue = (kg: number) => `${Number(kg.toPrecision(6))} kg`;

/** Split a fitting's total mass across its parts in proportion to their volumes (equal if unknown). */
export function splitMass(totalKg: number, volumes: (number | null)[]): number[] {
  const known = volumes.every((v) => v !== null && v > 0);
  const sum = known ? volumes.reduce<number>((a, v) => a + (v as number), 0) : 0;
  return volumes.map((v) => (known && sum > 0 ? (totalKg * (v as number)) / sum : totalKg / volumes.length));
}
// Names vendor CAD leaves on bodies that say nothing about the part ("Mirror 1", "Body2").
const GENERIC_PART_NAME = /^(part|body|solid|mirror|extrude|revolve|sweep|loft|fillet|chamfer|pattern|boolean|split|shell|thicken|import(ed)?|surface|feature)[\s_-]*\d*$/i;

/** What each part of a Part Studio should be called, given the hub's display name. */
export function partNames(display: string, originals: string[]): string[] {
  if (originals.length === 1) return [display];
  return originals.map((original, i) =>
    original && !GENERIC_PART_NAME.test(original.trim()) ? `${display} - ${original.trim()}` : `${display} (${i + 1})`,
  );
}

const ISOMETRIC = '0.707,0.707,0,0,-0.408,0.408,0.816,0,0.577,-0.577,0.577,0';

export type Auth = { kind: 'keys' } | { kind: 'bearer'; token: string };
export type TranslationState = { state: 'ACTIVE' | 'DONE' | 'FAILED'; resultElementIds: string[]; failureReason: string };
export type ElementRef = { documentId: string; workspaceId: string; elementId: string };
/** massKg: a number sets the parts' mass, null clears an earlier one, undefined leaves it alone. */
export type StudioProps = { elementId: string; name?: string; massKg?: number | null };
export type Image = { data: Buffer; ext: 'png' | 'jpg' | 'svg' };

/** What the hub needs from Onshape. Implemented for real below and faked in mock.ts. */
export interface OnshapeClient {
  libraryWorkspaceId(): Promise<string>;
  startImport(filePath: string, filename: string): Promise<string>;
  /** Status of several imports; batched into as few API calls as possible. */
  getTranslations(translationIds: string[]): Promise<Map<string, TranslationState>>;
  listPartStudios(wvm: 'w' | 'v', wvmId: string): Promise<{ id: string; name: string }[]>;
  /**
   * Set properties on the parts inside these Part Studios (workspace): their names after the
   * hub name, and/or their mass from the hub weight. 2 calls total, plus 1 per multi-part
   * studio that gets a mass (its weight is split across the parts by volume).
   */
  setPartProperties(studios: StudioProps[]): Promise<void>;
  createVersion(name: string, description: string): Promise<string>;
  renderThumbnail(versionId: string, elementId: string): Promise<Image>;
  /** Insert a whole Part Studio from the library (at a version) into the target assembly. */
  insertPartStudio(auth: Auth, target: ElementRef, source: { elementId: string; versionId: string }): Promise<void>;
}

export class OnshapeError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, what: string) {
    // Onshape's wording for a key created without the scope a call needs.
    const hint = /Invalid API key state/i.test(body)
      ? ' (the Onshape API key is missing a scope: the hub needs one created with Read and Write)'
      : '';
    super(`Onshape ${what} failed (${status})${hint}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

type RequestOpts = {
  query?: Record<string, string | number | boolean>;
  json?: unknown;
  form?: FormData;
  accept?: string;
  auth?: Auth;
};

function signedHeaders(method: string, url: URL, contentType: string): Record<string, string> {
  const nonce = crypto.randomBytes(18).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 25);
  const date = new Date().toUTCString();
  const str = [method, nonce, date, contentType, url.pathname, url.search.replace(/^\?/, '')].join('\n') + '\n';
  const hmac = crypto.createHmac('sha256', config.onshape.secretKey).update(str.toLowerCase()).digest('base64');
  return {
    Date: date,
    'On-Nonce': nonce,
    Authorization: `On ${config.onshape.accessKey}:HmacSHA256:${hmac}`,
  };
}

// Onshape counts every 2xx/3xx API call against the company's annual allowance
// (EDU Enterprise: 10,000/year for the whole Enterprise), so the hub counts them too.
let countCall: (() => void) | undefined;
export function onApiCall(fn: () => void): void {
  countCall = fn;
}

async function request(method: string, path: string, opts: RequestOpts = {}): Promise<Response> {
  let url = new URL(config.onshape.baseUrl + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
  const auth = opts.auth ?? { kind: 'keys' };

  // Onshape can answer 307 (possibly to another host); each hop must be re-signed.
  for (let hop = 0; hop < 4; hop++) {
    let body: BodyInit | undefined;
    // Content-Type is part of the signature, so send one on every request.
    let contentType = 'application/json';
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      contentType = 'application/json;charset=UTF-8; qs=0.09';
    } else if (opts.form) {
      // Let fetch pick the multipart boundary, then read it back so it can be signed.
      const probe = new Request(url, { method, body: opts.form });
      contentType = probe.headers.get('content-type') ?? '';
      body = await probe.arrayBuffer();
    }
    const headers: Record<string, string> = { Accept: opts.accept ?? JSON_ACCEPT, 'Content-Type': contentType };
    Object.assign(
      headers,
      auth.kind === 'keys' ? signedHeaders(method, url, contentType) : { Authorization: `Bearer ${auth.token}` },
    );
    const res = await fetch(url, { method, headers, body, redirect: 'manual' });
    if (res.status < 400) countCall?.();
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url);
      continue;
    }
    if (!res.ok) throw new OnshapeError(res.status, await res.text(), `${method} ${path}`);
    return res;
  }
  throw new Error(`Too many redirects for ${method} ${path}`);
}

/** A signed Onshape API call returning parsed JSON (service account keys unless `opts.auth` says otherwise). */
export async function json<T>(method: string, path: string, opts?: RequestOpts): Promise<T> {
  const res = await request(method, path, opts);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

type TranslationInfo = { id: string; requestState: string; resultElementIds?: string[] | null; failureReason?: string | null };
const translationState = (t: TranslationInfo): TranslationState => ({
  state: t.requestState as TranslationState['state'],
  resultElementIds: t.resultElementIds ?? [],
  failureReason: t.failureReason ?? '',
});

function imageExt(buf: Buffer): Image['ext'] {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  return 'png';
}

export function createOnshapeClient(): OnshapeClient {
  const did = config.onshape.libraryDocumentId;

  /** Volume of each part (m³), or null where Onshape can't say. 1 call. */
  async function partVolumes(wid: string, elementId: string, partIds: string[]): Promise<(number | null)[]> {
    try {
      const res = await json<{ bodies?: Record<string, { volume?: number[] }> }>(
        'GET',
        `${API}/partstudios/d/${did}/w/${wid}/e/${elementId}/massproperties`,
        { query: { massAsGroup: false } },
      );
      return partIds.map((id) => res.bodies?.[id]?.volume?.[0] ?? null);
    } catch {
      return partIds.map(() => null); // fall back to an equal split
    }
  }
  let workspaceId: string | undefined;

  const client: OnshapeClient = {
    async libraryWorkspaceId() {
      if (!workspaceId) {
        const doc = await json<{ defaultWorkspace: { id: string } }>('GET', `${API}/documents/${did}`);
        workspaceId = doc.defaultWorkspace.id;
      }
      return workspaceId;
    },

    async startImport(filePath, filename) {
      const wid = await client.libraryWorkspaceId();
      const form = new FormData();
      form.set('file', await fs.openAsBlob(filePath), filename);
      // The new tab is named after the file, so callers pass the hub's display name as the filename.
      form.set('encodedFilename', encodeURIComponent(filename));
      form.set('flattenAssemblies', 'true'); // assemblies/multi-body files -> one Part Studio
      form.set('storeInDocument', 'true'); // false would only create external data, not a Part Studio
      form.set('allowFaultyParts', 'true');
      form.set('yAxisIsUp', 'false');
      form.set('notifyUser', 'false');
      const info = await json<{ id: string }>('POST', `${API}/translations/d/${did}/w/${wid}`, { form });
      return info.id;
    },

    async getTranslations(ids) {
      const found = new Map<string, TranslationState>();
      const wanted = new Set(ids);
      // One call lists up to 20 of the document's imports, so a batch is checked in one
      // or two calls. The listing's order isn't documented, so read at most the pages a
      // batch this size could need, then ask for any stragglers one by one.
      if (ids.length > 2) {
        const pages = Math.ceil(ids.length / 20) + 1;
        for (let page = 0; page < pages && found.size < wanted.size; page++) {
          const res = await json<{ items: TranslationInfo[] }>('GET', `${API}/translations/d/${did}`, {
            query: { offset: page * 20, limit: 20 },
          });
          for (const t of res.items ?? []) if (wanted.has(t.id)) found.set(t.id, translationState(t));
          if ((res.items ?? []).length < 20) break;
        }
      }
      for (const id of ids) {
        if (!found.has(id)) found.set(id, translationState(await json<TranslationInfo>('GET', `${API}/translations/${id}`)));
      }
      return found;
    },

    async listPartStudios(wvm, wvmId) {
      const elements = await json<{ id: string; name: string; elementType: string }[]>(
        'GET',
        `${API}/documents/d/${did}/${wvm}/${wvmId}/elements`,
        { query: { elementType: 'PARTSTUDIO' } },
      );
      return elements.filter((e) => e.elementType === 'PARTSTUDIO').map((e) => ({ id: e.id, name: e.name }));
    },

    async setPartProperties(studios) {
      if (!studios.length) return;
      const wid = await client.libraryWorkspaceId();
      // One call lists every part in the workspace; one more updates them all.
      const parts = await json<{ elementId: string; partId: string; name: string }[]>('GET', `${API}/parts/d/${did}/w/${wid}`);
      const items: { href: string; properties: { propertyId: string; value: string }[] }[] = [];
      for (const { elementId, name, massKg } of studios) {
        const own = parts.filter((p) => p.elementId === elementId);
        if (!own.length) continue;
        const names = name ? partNames(name, own.map((p) => p.name)) : null;
        let masses: (number | null)[] | null = null;
        if (massKg === null) masses = own.map(() => null);
        else if (massKg !== undefined) masses = own.length === 1 ? [massKg] : splitMass(massKg, await partVolumes(wid, elementId, own.map((p) => p.partId)));
        own.forEach((p, i) => {
          const properties: { propertyId: string; value: string }[] = [];
          if (names) properties.push({ propertyId: NAME_PROPERTY, value: names[i] });
          if (masses) properties.push({ propertyId: MASS_PROPERTY, value: masses[i] === null ? '' : massValue(masses[i]!) });
          if (properties.length) items.push({ href: `${config.onshape.baseUrl}/api/metadata/d/${did}/w/${wid}/e/${elementId}/p/${p.partId}`, properties });
        });
      }
      if (items.length) await json('POST', `${API}/metadata/d/${did}/w/${wid}`, { json: { items } });
    },

    async createVersion(name, description) {
      const wid = await client.libraryWorkspaceId();
      const v = await json<{ id: string }>('POST', `${API}/documents/d/${did}/versions`, {
        json: { documentId: did, workspaceId: wid, name, description },
      });
      return v.id;
    },

    async renderThumbnail(versionId, elementId) {
      const res = await json<{ images: (string | string[])[] }>(
        'GET',
        `${API}/partstudios/d/${did}/v/${versionId}/e/${elementId}/shadedviews`,
        {
          query: {
            viewMatrix: ISOMETRIC,
            outputWidth: 300,
            outputHeight: 300,
            pixelSize: 0, // fit the model to the image
            edges: 'show',
            showAllParts: true,
            useAntiAliasing: true,
          },
        },
      );
      const first = res.images?.flat()[0];
      if (!first) throw new Error('Onshape returned no shaded view');
      const data = Buffer.from(first, 'base64');
      return { data, ext: imageExt(data) };
    },

    async insertPartStudio(auth, target, source) {
      await request(
        'POST',
        `${API}/assemblies/d/${target.documentId}/w/${target.workspaceId}/e/${target.elementId}/instances`,
        {
          auth,
          json: {
            documentId: did,
            elementId: source.elementId,
            versionId: source.versionId,
            isWholePartStudio: true, // multi-body fittings come in as one unit
            isAssembly: false,
          },
        },
      );
    },
  };
  return client;
}
