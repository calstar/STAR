/**
 * server/server-heartbeat.ts — the backend's watch on SERVER_HEARTBEAT (C6-3, issue #233).
 *
 * The heartbeat the actuator boards depend on goes out as a UDP broadcast from heartbeat_service
 * (or daq_bridge when `[server_heartbeat].send_from_daq_bridge`). Nothing on this host used to
 * see it, so when its sender died the operator heard nothing until the boards aborted. Both
 * senders now send a loopback copy of every packet to 127.0.0.1:`[server_heartbeat].monitor_port`;
 * this module receives those, and raises the keyed alert `server_heartbeat_lost` when none has
 * arrived for SERVER_HEARTBEAT_LOST_MS, and clears it on the next one.
 *
 * The watch arms on the first heartbeat it sees: a stand where nothing has sent one since the
 * backend started (mock mode, a laptop) raises nothing. It only observes; the boards' own
 * reaction to a lost heartbeat is theirs.
 *
 * Event-loop only. No effect at import: server.ts calls startServerHeartbeatWatch().
 */

import * as dgram from 'dgram';
import { readConfig } from '../routes/config.js';
import { raiseAlert, clearAlert } from './notifications.js';

/** Must match `ServerHeartbeatConfig::monitor_port`'s default in lib/include/config/Config.hpp. */
export const DEFAULT_MONITOR_PORT = 8093;

/**
 * Alert when no SERVER_HEARTBEAT has arrived for this long. The senders beat every 200 ms
 * (`[server_heartbeat].interval_ms`), so 2 s is ten missed beats: past any scheduling jitter, and
 * well inside the 15 s after which the actuator boards abort on their own (D-HB), which leaves the
 * operator time to act.
 */
export const SERVER_HEARTBEAT_LOST_MS = 2000;

/** How often the watch checks the age of the last heartbeat. */
export const SERVER_HEARTBEAT_CHECK_MS = 500;

export const SERVER_HEARTBEAT_ALERT_KEY = 'server_heartbeat_lost';

const SERVER_HEARTBEAT_TYPE = 2;
const SERVER_HEARTBEAT_LEN = 7; // type, version, timestamp_ms u32 LE, engine_state

let lastHeartbeatMs: number | null = null;

/** One datagram from the monitor port. Returns true if it was a SERVER_HEARTBEAT. */
export function noteServerHeartbeat(msg: Buffer, now: number = Date.now()): boolean {
  if (msg.length < SERVER_HEARTBEAT_LEN || msg.readUInt8(0) !== SERVER_HEARTBEAT_TYPE) return false;
  lastHeartbeatMs = now;
  clearAlert(SERVER_HEARTBEAT_ALERT_KEY, now);
  return true;
}

/** The periodic check: raise the alert once the last heartbeat is older than the threshold. */
export function checkServerHeartbeat(now: number = Date.now()): void {
  if (lastHeartbeatMs === null) return; // never seen one: nothing to lose yet
  const age = now - lastHeartbeatMs;
  if (age > SERVER_HEARTBEAT_LOST_MS) {
    raiseAlert(
      SERVER_HEARTBEAT_ALERT_KEY,
      'error',
      `Server heartbeat lost: no SERVER_HEARTBEAT for over ${SERVER_HEARTBEAT_LOST_MS / 1000} s (actuator boards abort after 15 s without it)`,
      now,
    );
  }
}

/** Test hook: forget the last heartbeat. */
export function resetServerHeartbeatWatch(): void {
  lastHeartbeatMs = null;
}

/** The monitor port from config, or the default. 0 means the copy is off and there is nothing to watch. */
export function serverHeartbeatMonitorPort(): number {
  try {
    const p = (readConfig() as any)?.server_heartbeat?.monitor_port;
    if (typeof p === 'number' && Number.isInteger(p) && p >= 0 && p <= 65535) return p;
  } catch { /* fall back to the default */ }
  return DEFAULT_MONITOR_PORT;
}

/** Bind the loopback monitor port and start the periodic check. Null when the copy is off. */
export function startServerHeartbeatWatch(port: number = serverHeartbeatMonitorPort()): dgram.Socket | null {
  if (port === 0) {
    console.log('[ThinServer] Server heartbeat watch off ([server_heartbeat].monitor_port = 0)');
    return null;
  }
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg: Buffer) => { noteServerHeartbeat(msg); });
  sock.on('error', (err) => {
    // Never fatal: the watch is observation only. Say so loudly, since without it a lost
    // heartbeat goes unannounced again.
    console.error(`[ThinServer] Server heartbeat watch on 127.0.0.1:${port} failed — heartbeat loss will NOT be announced:`, err);
  });
  sock.bind(port, '127.0.0.1', () => {
    console.log(`[ThinServer] Server heartbeat watch listening on 127.0.0.1:${port}`);
  });
  const timer = setInterval(() => checkServerHeartbeat(), SERVER_HEARTBEAT_CHECK_MS);
  sock.on('close', () => clearInterval(timer));
  return sock;
}
