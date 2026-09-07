/**
 * Which design this browser has open, for the code that has to name it.
 *
 * Two consumers, which is why it is not just a local in the designs bar:
 * `DesignVersions` remembers your design across reloads, and `api/client`
 * stamps it onto every request that edits the live config so the backend can
 * refuse the write when you do not hold the checkout (see backend/checkout.py).
 */

import type { DocRef } from '../api/documents';

// v2 because the remembered design is now (owner, id): a shared design is not
// identified by its id alone. A v1 value is a bare id, which was always one of
// your own, so it migrates to {owner: null}.
const ACTIVE_KEY = 'engine-design.activeDoc.v2';
const LEGACY_ACTIVE_KEY = 'engine-design.activeDoc.v1';

export function readActive(): DocRef | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DocRef;
      if (parsed && typeof parsed.id === 'string') return parsed;
    }
    const legacy = localStorage.getItem(LEGACY_ACTIVE_KEY);
    return legacy ? { id: legacy, owner: null } : null;
  } catch {
    return null;
  }
}

export function writeActive(ref: DocRef | null): void {
  try {
    if (ref) localStorage.setItem(ACTIVE_KEY, JSON.stringify({ id: ref.id, owner: ref.owner ?? null }));
    else localStorage.removeItem(ACTIVE_KEY);
    localStorage.removeItem(LEGACY_ACTIVE_KEY);
  } catch {
    /* private mode / storage disabled -- the bar still works, it just forgets */
  }
}

/** Headers naming the open design, for a request that edits the config. */
export function designHeaders(): Record<string, string> {
  const ref = readActive();
  if (!ref) return {};
  const h: Record<string, string> = { 'X-Design-Id': ref.id };
  if (ref.owner) h['X-Design-Owner'] = ref.owner;
  return h;
}

/**
 * The same thing as query parameters.
 *
 * The optimizer layers stream over `EventSource`, which cannot set a request
 * header, so those routes read the design from the query string instead.
 */
export function designParams(): Record<string, string> {
  const ref = readActive();
  if (!ref) return {};
  const p: Record<string, string> = { design_id: ref.id };
  if (ref.owner) p.design_owner = ref.owner;
  return p;
}
