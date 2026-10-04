/**
 * Layer X's URL state (docs/layerx/GUI-SPEC.md, "URL state"):
 *
 *   ?lx=2&run=<id>&page=feed&t=1.85&vs=<id>
 *
 * Kept in sync with `history.replaceState`, so a link reopens the run, the page, the cursor and the
 * comparison. The app has no router: only these params are read and written, every other param is
 * left exactly where it was.
 *
 * `lx` says "open Layer X". Since the cut-over (2026-10-03) the rebuilt GUI is Layer X; `lx=1`
 * opens the old one (components/layerx/) for one release, and `lx=2`, the old opt-in, still
 * opens the new one. A link written by the new GUI keeps whatever `lx` the page was opened with,
 * and says 2 when there was none, so it opens on the Layer X tab and in the GUI it came from.
 *
 * TODO(next release): remove LX_V1 and the old components/layerx/ GUI it opens.
 */

export const LX_PAGES = ['overview', 'feed', 'engine', 'hardware', 'flight', 'stand', 'uncertainty', 'record'] as const;
export type LxPage = (typeof LX_PAGES)[number];

/** The value of `lx` the rebuilt GUI writes into its links. */
export const LX_V2 = '2';
/** The value of `lx` that opens the old GUI, kept for one release after the cut-over. */
export const LX_V1 = '1';

export interface LxUrlState {
  /** The raw `lx` param, or null when absent. */
  lx: string | null;
  run: string | null;
  page: LxPage | null;
  /** Cursor [s, burn clock]. */
  t: number | null;
  /** The compared run. */
  vs: string | null;
}

export function isLxPage(x: unknown): x is LxPage {
  return typeof x === 'string' && (LX_PAGES as readonly string[]).includes(x);
}

const RUN_ID = /^[A-Za-z0-9._-]{1,80}$/;

/** A run id as the backend writes them; anything else is ignored rather than fetched. */
function runId(x: string | null): string | null {
  return x && RUN_ID.test(x) ? x : null;
}

export function readLxUrl(search: string): LxUrlState {
  const q = new URLSearchParams(search);
  const tRaw = q.get('t');
  const t = tRaw !== null && tRaw.trim() !== '' ? Number(tRaw) : NaN;
  const page = q.get('page');
  return {
    lx: q.get('lx'),
    run: runId(q.get('run')),
    page: isLxPage(page) ? page : null,
    t: Number.isFinite(t) ? t : null,
    vs: runId(q.get('vs')),
  };
}

/** The cursor as the URL carries it: to the millisecond, no trailing zeros ("1.85", "-0.4"). */
export function formatUrlT(t: number): string {
  const r = Number(t.toFixed(3));
  return String(Object.is(r, -0) ? 0 : r);
}

/**
 * The search string with Layer X's params set to `next` and every other param untouched. A null,
 * empty or default value (page overview) removes its param. Returns '' or '?…'.
 */
export function writeLxUrl(search: string, next: Partial<Omit<LxUrlState, 'lx'>>): string {
  const q = new URLSearchParams(search);
  const lx = q.get('lx');
  if (!lx) q.set('lx', LX_V2);
  const put = (k: string, v: string | null | undefined) => {
    if (v === undefined) return;
    if (v === null || v === '') q.delete(k);
    else q.set(k, v);
  };
  if ('run' in next) put('run', next.run ?? null);
  if ('page' in next) put('page', next.page && next.page !== 'overview' ? next.page : null);
  if ('t' in next) put('t', next.t === null || next.t === undefined || !Number.isFinite(next.t) ? null : formatUrlT(next.t));
  if ('vs' in next) put('vs', next.vs ?? null);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * Whether this page load mounts the rebuilt GUI: always, since the cut-over, unless the URL asks for
 * the old one with `lx=1` (kept for one release). The `storage` argument is the pre-cut-over opt-in,
 * no longer needed; it is accepted so old callers compile.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function wantsV2(search: string, _storage: Pick<Storage, 'getItem'> | null = null): boolean {
  return new URLSearchParams(search).get('lx') !== LX_V1;
}

/** Whether the URL names Layer X at all (lx=1 or lx=2): the app opens on its tab. */
export function wantsLayerXTab(search: string): boolean {
  const lx = new URLSearchParams(search).get('lx');
  return lx === LX_V1 || lx === LX_V2;
}

/** The dev gallery of the Layer X primitives and charts, for visual QA. */
export function wantsGallery(search: string): boolean {
  return new URLSearchParams(search).get('lx-gallery') === '1';
}

/** Writes Layer X's params into the address bar without a history entry; a no-op off the browser
 * or when nothing changes. */
export function replaceLxUrl(next: Partial<Omit<LxUrlState, 'lx'>>): void {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  const { pathname, search, hash } = window.location;
  const s = writeLxUrl(search, next);
  if (s === search || (s === '' && search === '')) return;
  try {
    window.history.replaceState(window.history.state, '', `${pathname}${s}${hash}`);
  } catch {
    /* Safari throws past ~100 replaceState calls in 30 s; the URL is a convenience, not state. */
  }
}
