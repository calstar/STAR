/**
 * Stands as shared documents: the client half of backend/routers/stands.py.
 *
 * The store is pid-designer's (lib/stardesign + lib/stardesign-ui): an owner,
 * a share list, a checkout, microversions and named releases. A stand is the
 * cockpit's configuration -- which drawing and engine, every setting, the
 * hookup (console names included), where the knobs sit, what the console
 * shows and in what order -- not its running state, which stays in the
 * session.
 */

import { createDesignApi } from '@stardesign-ui';
import type { ConsoleView } from './lib/shown';
import { RequestError, sayDetail } from './api';

export interface StandPayload {
  diagram: string;
  engine: string;
  fluid_set: string;
  machine: string;
  /** Configuration-tab settings, keyed as the backend's tunables name them. */
  setup: Record<string, number | boolean | string>;
  /** Valve pins and regulator knobs (`{valves, knobs}`). */
  hookup: Record<string, unknown>;
  /** Where the knobs sit: `{knobs: {id: psig}}`. */
  operating_point: Record<string, unknown>;
  /** What the console shows and in what order (`lib/shown.ts` ConsoleView). */
  console: Partial<ConsoleView>;
  notes: string;
}

export const EMPTY_STAND: StandPayload = {
  diagram: '',
  engine: '',
  fluid_set: 'hotfire',
  machine: 'diablo',
  setup: {},
  hookup: {},
  operating_point: {},
  console: {},
  notes: '',
};

export const standApi = createDesignApi<StandPayload>({
  base: '/api/twin/stands',
  usersPath: '/api/twin/users',
  codec: {
    toBody: (payload) => ({ ...payload }),
    fromBody: (body) => ({ ...EMPTY_STAND, ...(body as Partial<StandPayload>) }),
    empty: () => ({ ...EMPTY_STAND }),
  },
});

// ------------------------------------------------------------- stand bundles
//
// A stand as one file (`*.hotbench.json`, backend/bundle.py): the drawing, the
// engine and its card, the state table, the drawing's overrides and the hookup
// it runs on, carried with the stand so another server can open it. The server
// packs and unpacks the library's part; the stand document itself is created
// here, through `standApi`, so ownership and sharing stay where they are.

/** A bundle as the server writes it; the client only names and saves it. */
export interface StandBundle {
  format: string;
  version: number;
  name: string;
  [key: string]: unknown;
}

/** What an import made of a bundle: the stand to create, ids now this
 *  library's, and what it did that the person should know. */
export interface ImportedStand {
  name: string;
  stand: StandPayload;
  notes: string[];
}

async function post<T>(url: string, body: unknown, what: string): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.json().then((b) => b?.detail, () => undefined);
    throw new RequestError(sayDetail(detail, `${what} failed (${response.status}).`), response.status);
  }
  return (await response.json()) as T;
}

export const exportStand = (name: string, stand: StandPayload) =>
  post<StandBundle>('/api/twin/bundle/export', { name, stand }, 'Exporting the stand');

export const importStand = (bundle: unknown) =>
  post<ImportedStand>('/api/twin/bundle/import', bundle, 'Importing the stand');

/** Hand the bundle to the browser as a file named after the stand. */
export function saveBundle(bundle: StandBundle): void {
  const slug = (bundle.name || 'stand').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'stand';
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 1)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug}.hotbench.json`;
  a.click();
  URL.revokeObjectURL(url);
}
