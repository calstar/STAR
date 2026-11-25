/**
 * origin-policy — which browser origins may use the backend's HTTP API and WebSocket (SEC-6).
 *
 * Identity on the direct port is positional (no `X-Auth-Email` ⇒ operator), so a hostile page
 * open in a bench laptop's browser could otherwise open `ws://<stand>:8081`, arm and command the
 * engine, or POST to the API. A browser always says where a page came from in `Origin`; this
 * module answers whether that is the GUI's own:
 *
 *   - no `Origin` at all: allowed. Browsers send one on every WebSocket handshake and every
 *     cross-origin request, so its absence means a non-browser client (curl, the test
 *     harnesses, the C++ tools) or a same-origin GET, none of which this check is about;
 *   - an origin in `DAQ_ALLOWED_ORIGINS` (comma-separated, full origins; default the Caddy site
 *     `https://daq-server.starberkeley.org`, see deploy/caddy/Caddyfile);
 *   - the GUI served by this machine: http(s) on the GUI port (`GUI_PORT`, default 3000, which
 *     is also the Vite dev server's port) at `localhost`, a loopback address, this host's name,
 *     or any address on one of this host's interfaces (a LAN client loading
 *     `http://<stand-ip>:3000`).
 *
 * Hostnames are matched against this machine's own names, never against the request's `Host`
 * header, so a DNS-rebound page (Host and Origin both the attacker's name) is still refused.
 * Everything else, including the literal `null` origin of a sandboxed or file:// page, is refused.
 *
 * Reads `DAQ_ALLOWED_ORIGINS` and `GUI_PORT` itself: both api-server.ts and server/ws-clients.ts
 * use it, and api/* may not import server/env.ts. Import-time effects: none.
 */

import * as os from 'os';

const DEFAULT_ALLOWED_ORIGINS = 'https://daq-server.starberkeley.org';

function configuredOrigins(): Set<string> {
  const raw = process.env.DAQ_ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS;
  const out = new Set<string>();
  for (const part of raw.split(',')) {
    const s = part.trim();
    if (!s) continue;
    try {
      out.add(new URL(s).origin);
    } catch {
      console.warn(`[OriginPolicy] DAQ_ALLOWED_ORIGINS entry is not an origin, ignored: ${s}`);
    }
  }
  return out;
}

function guiPorts(): Set<string> {
  const ports = new Set<string>(['3000']);
  const n = parseInt(process.env.GUI_PORT ?? '3000', 10);
  if (Number.isFinite(n) && n > 0) ports.add(String(n));
  return ports;
}

/** This machine's own names and addresses, as a URL's `hostname` spells them. */
function localHostnames(): Set<string> {
  const names = new Set<string>(['localhost', '127.0.0.1', '[::1]']);
  const h = os.hostname().toLowerCase();
  if (h) {
    names.add(h);
    names.add(`${h}.local`);
  }
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      names.add(a.family === 'IPv6' ? `[${a.address.split('%')[0].toLowerCase()}]` : a.address);
    }
  }
  return names;
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (configuredOrigins().has(u.origin)) return true;
  const host = u.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
  return guiPorts().has(u.port) && (loopback || localHostnames().has(host));
}
