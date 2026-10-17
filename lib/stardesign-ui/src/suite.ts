/**
 * Hotbench, a STAR project: three apps, one pipeline. Draw the stand (P&ID),
 * design the engine (Engine), run the stand from its drawing (Twin).
 *
 * Where each sibling lives, so every app's header can link the other two
 * (SuiteSwitcher.tsx). Separate from the component because react-refresh
 * requires a component file to export nothing else.
 *
 * A sibling's address comes from the build when it says (VITE_HOTBENCH_ENGINE_URL,
 * VITE_HOTBENCH_PID_URL, VITE_HOTBENCH_TWIN_URL); otherwise it is worked out
 * from where this app is served:
 *   - on this machine, by port: the dev stack (5173 / 5174 / 5177) and the
 *     demo stack (scripts/demo.sh: 5273 / 5274 / 5277) each map to their own;
 *   - on *.starberkeley.org, by subdomain (engine-design / pid-designer /
 *     feed-twin, as deploy/apps/README.md routes them).
 * Anywhere else the sibling has no address, and the switcher says so on its
 * hover rather than link somewhere that is not there.
 */

export type SuiteApp = 'engine' | 'pid' | 'twin';

export interface SuiteEntry {
  app: SuiteApp;
  /** What the switcher shows. */
  label: string;
  /** The app's whole name, as its <title> and hovers give it. */
  name: string;
  /** What it is for, in a few words, for the hover. */
  does: string;
  /** Its Vite ports on this machine: [dev stack, demo stack]. */
  ports: readonly [number, number];
  /** Its subdomain on the deployed site. */
  subdomain: string;
}

/** In the order the header lists them. */
export const SUITE: readonly SuiteEntry[] = [
  { app: 'engine', label: 'Engine', name: 'Hotbench Engine', does: 'design the engine', ports: [5173, 5273], subdomain: 'engine-design' },
  { app: 'pid', label: 'P&ID', name: 'Hotbench P&ID', does: 'draw the stand', ports: [5174, 5274], subdomain: 'pid-designer' },
  { app: 'twin', label: 'Twin', name: 'Hotbench Twin', does: 'run the stand from its drawing', ports: [5177, 5277], subdomain: 'feed-twin' },
];

/** The deployed site's domain: every app is a subdomain of it. */
export const SUITE_DOMAIN = 'starberkeley.org';

/** The parts of `window.location` the mapping reads. */
export interface SuiteWhere {
  protocol: string;
  hostname: string;
  port: string;
}

/** Addresses the build gave, by app; blank means "work it out". */
export type SuiteUrls = Partial<Record<SuiteApp, string | undefined>>;

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The Vite env names that override each app's address. */
export const SUITE_ENV: Record<SuiteApp, string> = {
  engine: 'VITE_HOTBENCH_ENGINE_URL',
  pid: 'VITE_HOTBENCH_PID_URL',
  twin: 'VITE_HOTBENCH_TWIN_URL',
};

/** The addresses the build was given, read from a Vite env object. */
export function suiteUrlsFrom(env: Record<string, unknown> | undefined): SuiteUrls {
  const out: SuiteUrls = {};
  for (const e of SUITE) {
    const v = env?.[SUITE_ENV[e.app]];
    if (typeof v === 'string' && v.trim()) out[e.app] = v.trim();
  }
  return out;
}

/**
 * Where `target` lives, seen from `here`: the build's address if it gave one,
 * else the sibling port on this machine, else the sibling subdomain on the
 * deployed site, else null (not served next to this one).
 */
export function siblingUrl(target: SuiteApp, here: SuiteWhere, given: SuiteUrls = {}): string | null {
  const set = given[target]?.trim();
  if (set) return set;
  const to = SUITE.find((e) => e.app === target);
  if (!to) return null;
  const host = here.hostname.toLowerCase();
  const protocol = here.protocol || 'http:';

  if (LOCAL.has(host)) {
    const port = Number(here.port);
    for (const e of SUITE) {
      const stack = e.ports.indexOf(port);
      if (stack >= 0) {
        const name = host === '::1' ? '[::1]' : host;
        return `${protocol}//${name}:${to.ports[stack]}/`;
      }
    }
    return null;
  }

  const suffix = `.${SUITE_DOMAIN}`;
  if (host.endsWith(suffix)) {
    const labels = host.slice(0, -suffix.length).split('.');
    if (SUITE.some((e) => e.subdomain === labels[0])) {
      labels[0] = to.subdomain;
      const port = here.port ? `:${here.port}` : '';
      return `${protocol}//${labels.join('.')}${suffix}${port}/`;
    }
  }
  return null;
}
