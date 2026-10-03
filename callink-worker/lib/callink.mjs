// The CalLink session and the read calls everything else is built on. The browser
// profile that `node session.mjs login` signs in is reused for its cookies; pages are
// only rendered where CalLink's own HTML has to be parsed.
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';

export const BASE = 'https://callink.berkeley.edu';
export const ORG = 'STAR';
export const FORM_URL = `${BASE}/actionCenter/organization/star/Finance/CreatePurchaseRequest`;
const HOME = process.env.CALLINK_HOME ?? path.join(os.homedir(), '.local/share/star');
export const PROFILE = process.env.CALLINK_PROFILE ?? path.join(HOME, 'callink-profile');
export const DATA = process.env.CALLINK_DATA ?? path.join(HOME, 'callink-data');
export const RUNS = process.env.CALLINK_OUT ?? path.join(HOME, 'callink-runs');

export const log = (...a) => console.log(new Date().toISOString(), ...a);
// Playwright appends a call log with the request's Cookie header to its errors: keep line one only.
export const brief = e => String(e?.message ?? e).split('\n')[0];

export class SessionExpired extends Error {
  constructor(what) {
    super(`${what}: CalLink session expired; run: node session.mjs login`);
  }
}

/** The signed-in browser profile. One process at a time may hold it. */
export function openSession() {
  return chromium.launchPersistentContext(PROFILE, { headless: true });
}

/** GET with CalLink's habit in mind: it sometimes stalls a request for 30 s, and the
 * same call answers at once when retried. Never follows redirects (a redirect means
 * the session is gone). */
export async function get(ctx, url, opts = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ctx.request.get(url.startsWith('http') ? url : BASE + url, { maxRedirects: 0, ...opts });
    } catch (e) {
      if (attempt === 3 || !/Timeout/.test(e.message)) throw new Error(brief(e));
      log(`retrying ${url.replace(BASE, '').split('?')[0]} after: ${brief(e)}`);
      await new Promise(res => setTimeout(res, 2000 * attempt));
    }
  }
}

export async function getJson(ctx, p) {
  const r = await get(ctx, p, { headers: { accept: 'application/json' } });
  if (r.status() >= 300 && r.status() < 400) throw new SessionExpired(`GET ${p.split('?')[0]}`);
  if (r.status() !== 200) throw new Error(`GET ${p.split('?')[0]} -> ${r.status()}`);
  return r.json();
}

/** When the stored CalLink login runs out (a fixed 24 h from sign-in), or null. */
export async function sessionExpiresAt(ctx) {
  const c = (await ctx.cookies()).find(c => c.name === 'App.Login' && /callink\.berkeley\.edu$/.test(c.domain));
  return c && c.expires > 0 ? new Date(c.expires * 1000) : null;
}

/** Does the stored session still reach the purchase-request form? */
export async function sessionAlive(ctx) {
  const r = await get(ctx, FORM_URL);
  return r.status() === 200;
}

const PAGE_SIZE = 100;

/** CalLink's request list, newest first. It leaves out deleted requests. */
export async function listAll(ctx, { limit = Infinity, quiet = false } = {}) {
  const rows = [];
  for (let skip = 0; rows.length < limit; skip += PAGE_SIZE) {
    const q = new URLSearchParams({
      take: String(Math.min(PAGE_SIZE, limit)), skip: String(skip), status: 'All', searchText: '', categoryId: '0',
      stageId: '0', branchId: '0', processId: '0', orderByField: 'SubmittedOn',
      orderByDirection: 'Descending', showOnlyRecentlyDeleted: 'false',
    });
    const page = await getJson(ctx, `/api/finance/${ORG}/requests/purchase/list-items?${q}`);
    rows.push(...page.items);
    if (!quiet) log(`listed ${rows.length}/${page.totalItems}`);
    if (page.items.length < PAGE_SIZE || rows.length >= page.totalItems) break;
  }
  return rows.slice(0, limit);
}
