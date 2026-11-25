/**
 * server/subscription-watch.ts — detection for D-SUB (#23, issue #227): an Elodin subscription
 * the DB accepted that never delivers.
 *
 * Detection only. The root cause (D-SLOT: a board in slot > 8 wraps its uint8 table ids onto
 * another board's, and a subscription made while that id is re-registered binds to components
 * nobody writes) is not fixed here. Three parts:
 *
 *  1. **Table-id collisions.** At startup and on every Elodin connect the config's
 *     table-id → entity map is checked. Two entities on one id is the D-SLOT precondition: it is
 *     logged loudly and raised as the keyed alert `table_id_collision`.
 *  2. **Per-channel liveness.** The registry records when each pair last delivered and when it
 *     was subscribed. A CALIBRATED channel is stale when its RAW sibling is delivering, other
 *     calibrated channels from the same publisher are delivering (so the publisher is up — this
 *     is what keeps a stopped calibration_service from being read as a dead stream), and it has
 *     delivered nothing for STALE_MS since it was subscribed or last delivered. Only calibrated
 *     channels with a raw sibling are judged: heartbeats, self-test, sequencer and controller
 *     state are sparse and have no sibling, so "quiet" says nothing about them. The same rule
 *     catches a stale binding on calibration_service's side (its raw subscription dead).
 *  3. **Recovery.** A stale channel is listed in CONNECTION_STATUS (`staleChannels`) and raises
 *     `stale_subscription`. The remedy is a whole-connection reconnect through the existing
 *     clearSubscriptionState() + disconnect() path: elodin-db 0.16.1 has no unsubscribe, and
 *     re-sending a pair that is merely quiet would double it (C6-2), so a fresh connection is the
 *     only duplicate-free remedy. Rate-limited to one per RECOVERY_MIN_INTERVAL_MS and at most
 *     MAX_RECOVERIES per episode: a binding that survives a fresh subscribe is not ours (it is
 *     calibration's), and reconnecting again would only cost the GUI another gap. The alert
 *     clears once every flagged channel has delivered again.
 *
 * Event-loop only. No effect at import: server.ts calls startSubscriptionWatch(elodin).
 */

import type { ElodinClient } from '../elodin-client.js';
import { readDeployedConfig } from '../routes/config.js';
import { t7Channels } from '../../../shared/config-validation.js';
import { boardSlot } from '../sensor-config.js';
import { clearSubscriptionState, pairDeliveredAtMs, pairSubscribedAtMs } from '../elodin-vtable-registry.js';
import { raiseAlert, clearAlert } from './notifications.js';

export const TABLE_ID_COLLISION_ALERT_KEY = 'table_id_collision';
export const STALE_SUBSCRIPTION_ALERT_KEY = 'stale_subscription';

/** A raw (or publisher) signal counts as "delivering" when it delivered within this window. */
export const LIVE_MS = 2000;
/** A calibrated channel silent this long while its evidence holds is stale. Calibrated rows
 *  follow their raw rows sample for sample, so 5 s is many missed rows, not jitter. */
export const STALE_MS = 5000;
/** A flagged channel whose raw sibling has been silent this long is dropped: its board went
 *  away, and the alert's premise with it. */
export const EVIDENCE_LOST_MS = 10_000;
/** How often the watch looks. */
export const SUBSCRIPTION_CHECK_MS = 1000;
/** At most one reconnect per this interval... */
export const RECOVERY_MIN_INTERVAL_MS = 30_000;
/** ...and at most this many per episode (an episode ends when every flagged channel delivers). */
export const MAX_RECOVERIES = 2;

// ── The config's table-id → entity map ───────────────────────────────────────

export interface TableEntry {
  /** `high,low`, the registry's key. */
  key: string;
  /** The entity the C++ registrars name for it, e.g. `PT10_Cal.CH1` (slot unfolded, as they do). */
  entity: string;
  /** The config board it belongs to. */
  board: string;
  kind: 'raw' | 'cal' | 'cmd' | 'heartbeat';
  /** For `cal`: the raw sibling's key. */
  raw?: string;
}

const hex = (n: number) => `0x${n.toString(16).padStart(2, '0')}`;
const keyOf = (high: number, low: number) => `${high},${low & 0xff}`;
export const pairLabel = (key: string) => {
  const [h, l] = key.split(',').map(Number);
  return `[${hex(h)},${hex(l)}]`;
};

const SENSOR_HI: Record<string, [number, string]> = {
  PT: [0x20, 'PT'], TC: [0x21, 'TC'], RTD: [0x22, 'RTD'], LC: [0x23, 'LC'], ENC: [0x24, 'ENC'], ENCODER: [0x24, 'ENC'],
};

/**
 * Every table the config's boards publish, with the entity each registrar names for it. Low
 * bytes are computed as the C++ registrars compute them (`(slot-1)*0x20 + ch`, wrapped to a
 * byte), which is the same value the backend's `((slot-1)%8)+1` fold subscribes to.
 */
export function tableEntries(cfgIn?: unknown): TableEntry[] {
  const out: TableEntry[] = [];
  const cfg = (cfgIn ?? readDeployedConfig()) as { boards?: unknown };
  const boards = (cfg?.boards || {}) as Record<string, unknown>;
  for (const ch of t7Channels(boards as Record<string, any>)) {
    if (!ch.enabled) continue;
    const raw = keyOf(0x26, ch.rawLow);
    out.push({ key: raw, entity: ch.entity, board: ch.boardKey, kind: 'raw' });
    if (ch.calLow !== null && ch.calEntity) {
      out.push({ key: keyOf(0x26, ch.calLow), entity: ch.calEntity, board: ch.boardKey, kind: 'cal', raw });
    }
  }
  for (const [name, rawB] of Object.entries(boards)) {
    const b = rawB as Record<string, unknown>;
    if (!b || b.enabled === false) continue;
    const t = String(b.type ?? '').toUpperCase();
    if (t === 'T7') continue;
    const id = Number(b.board_id ?? b.id ?? 0);
    if (!Number.isInteger(id) || id <= 0 || id > 255) continue;
    const rawConnectors = Array.isArray(b.active_connectors) && (b.active_connectors as unknown[]).length > 0
      ? (b.active_connectors as unknown[])
      : Array.isArray(b.active_connections) ? (b.active_connections as unknown[]) : [];
    const active = rawConnectors.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x >= 1 && x <= 10);
    if (active.length === 0) continue;
    out.push({ key: keyOf(0x10, id), entity: `heartbeat of board_id ${id}`, board: name, kind: 'heartbeat' });
    const slot = boardSlot(id);
    if (t === 'ENVIRONMENTAL') {
      if (active.includes(1)) out.push({ key: keyOf(0x25, id), entity: `ENV${id}`, board: name, kind: 'raw' });
      continue;
    }
    const add = (rawHi: number, calHi: number, cmdHi: number | null, prefix: string) => {
      for (const c of active) {
        const lo = (slot - 1) * 0x20 + c;
        const raw = keyOf(rawHi, lo);
        out.push({ key: raw, entity: `${prefix}${slot}.CH${c}`, board: name, kind: 'raw' });
        out.push({ key: keyOf(calHi, lo + 0x10), entity: `${prefix}${slot}_Cal.CH${c}`, board: name, kind: 'cal', raw });
        if (cmdHi !== null) out.push({ key: keyOf(cmdHi, lo), entity: `${prefix}_CMD.B${slot}.CH${c}`, board: name, kind: 'cmd' });
      }
    };
    if (t === 'ACTUATOR') add(0x30, 0x31, 0x32, 'ACT');
    else if (t === 'BALL_VALVE') add(0x33, 0x34, 0x35, 'BV');
    else if (SENSOR_HI[t]) add(SENSOR_HI[t][0], SENSOR_HI[t][0], null, SENSOR_HI[t][1]);
  }
  return out;
}

export interface TableIdCollision {
  key: string;
  entities: Array<{ entity: string; board: string }>;
}

/** Table ids two or more config boards claim (two boards on one slot, a slot > 8 wrapping onto
 *  another's ids, or a duplicated board_id's heartbeat). One board never claims an id twice. */
export function tableIdCollisions(entries: TableEntry[]): TableIdCollision[] {
  const byKey = new Map<string, Map<string, string>>(); // key -> board -> entity
  for (const e of entries) {
    const m = byKey.get(e.key) ?? new Map<string, string>();
    if (!m.has(e.board)) m.set(e.board, e.entity);
    byKey.set(e.key, m);
  }
  const out: TableIdCollision[] = [];
  for (const [key, m] of byKey) {
    if (m.size > 1) out.push({ key, entities: [...m].map(([board, entity]) => ({ entity, board })) });
  }
  return out;
}

/** Check the deployed config (or `cfg`) for collisions; log and raise, or clear. Returns them. */
export function checkTableIdCollisions(cfg?: unknown, now: number = Date.now()): TableIdCollision[] {
  let collisions: TableIdCollision[];
  try {
    collisions = tableIdCollisions(tableEntries(cfg));
  } catch (e) {
    console.error('[SubscriptionWatch] could not build the table-id map from config:', e);
    return [];
  }
  if (collisions.length === 0) {
    clearAlert(TABLE_ID_COLLISION_ALERT_KEY, now);
    return collisions;
  }
  const lines = collisions.map((c) =>
    `${pairLabel(c.key)}: ${c.entities.map((e) => `${e.entity} ([boards.${e.board}])`).join(' / ')}`);
  console.error(
    `[SubscriptionWatch] ❌ TABLE-ID COLLISION: ${collisions.length} Elodin table id(s) are claimed by two ` +
    'boards. The last registrar wins; the other entity\'s data is lost or shown under the wrong name, ' +
    'and a subscription made while the id is re-registered can go silent forever (D-SLOT/D-SUB). ' +
    'Fix the board_id in config (slots are board_id % 10 and must be 1-8 and distinct).');
  for (const l of lines) console.error(`[SubscriptionWatch]    ${l}`);
  raiseAlert(
    TABLE_ID_COLLISION_ALERT_KEY,
    'error',
    `Config error: ${collisions.length} Elodin table id(s) shared by two boards — ` +
      `${lines.slice(0, 3).join('; ')}${lines.length > 3 ? '; …' : ''}. ` +
      'Those channels may be lost or mislabelled. Fix the board_id (slot = board_id % 10, 1-8, distinct).',
    now,
  );
  return collisions;
}

// ── Per-channel liveness ─────────────────────────────────────────────────────

/** Which process publishes a calibrated table: t7_bridge for a T7, calibration_service otherwise. */
const publisherOf = (key: string) => (key.startsWith(`${0x26},`) ? 't7_bridge' : 'calibration_service');

/**
 * Calibrated families that are registered but that nothing writes. calibration_service registers
 * ENC1_Cal.* (0x24) and never publishes a row for it (calibration_main.cpp calibrates PT, TC, RTD,
 * LC, ACT and ball valve only), so a silent ENC calibrated table is normal, not a dead stream.
 */
const UNPUBLISHED_CAL_HI = new Set([0x24]);

/** Calibrated entries that have a raw sibling and a publisher, de-duplicated by key (first entity wins). */
function calibratedWithSibling(entries: TableEntry[]): TableEntry[] {
  const seen = new Set<string>();
  const out: TableEntry[] = [];
  for (const e of entries) {
    if (e.kind !== 'cal' || !e.raw || seen.has(e.key)) continue;
    if (UNPUBLISHED_CAL_HI.has(Number(e.key.split(',')[0]))) continue;
    seen.add(e.key);
    out.push(e);
  }
  return out;
}

interface Flag { entity: string; raw: string; since: number; evidenceAt: number }

const flagged = new Map<string, Flag>();
/** Per publisher: since when some calibrated table of it has been delivering (this connection). */
const publisherLiveSince = new Map<string, number>();
let lastRecoveryMs = -Infinity;
let recoveries = 0;
let gaveUpLogged = false;

/** Test hook. */
export function resetSubscriptionWatch(): void {
  flagged.clear();
  publisherLiveSince.clear();
  lastRecoveryMs = -Infinity;
  recoveries = 0;
  gaveUpLogged = false;
}

/** The entities currently flagged stale, for CONNECTION_STATUS. Empty when nothing is. */
export function staleChannels(): string[] {
  return [...flagged.values()].map((f) => f.entity).sort();
}

/**
 * The calibrated channels that are stale right now (see the header for the rule). Pure apart
 * from reading the registry's delivery and subscribe times.
 */
export function staleCalibratedPairs(entries: TableEntry[], now: number): TableEntry[] {
  const cal = calibratedWithSibling(entries);
  const live = new Set<string>();
  for (const e of cal) {
    const at = pairDeliveredAtMs(e.key);
    if (at !== undefined && now - at < LIVE_MS) live.add(publisherOf(e.key));
  }
  for (const p of [...publisherLiveSince.keys()]) if (!live.has(p)) publisherLiveSince.delete(p);
  for (const p of live) if (!publisherLiveSince.has(p)) publisherLiveSince.set(p, now);

  const stale: TableEntry[] = [];
  for (const e of cal) {
    const sub = pairSubscribedAtMs(e.key);
    if (sub === undefined) continue; // refused, queued or not yet sent: the registry's business
    const rawAt = pairDeliveredAtMs(e.raw!);
    if (rawAt === undefined || now - rawAt >= LIVE_MS) continue; // its board is not sending
    const since = publisherLiveSince.get(publisherOf(e.key));
    if (since === undefined || now - since < STALE_MS) continue; // its publisher is not (yet) up
    const ref = Math.max(pairDeliveredAtMs(e.key) ?? -Infinity, sub);
    if (now - ref > STALE_MS) stale.push(e);
  }
  return stale;
}

/** One look: flag, unflag, alert, and reconnect when the rules allow. */
export function checkSubscriptionLiveness(client: ElodinClient, now: number = Date.now(), cfg?: unknown): void {
  let entries: TableEntry[];
  try {
    entries = tableEntries(cfg);
  } catch {
    return;
  }
  const stale = staleCalibratedPairs(entries, now);
  let added = false;
  for (const e of stale) {
    if (flagged.has(e.key)) continue;
    flagged.set(e.key, { entity: e.entity, raw: e.raw!, since: now, evidenceAt: now });
    added = true;
  }
  for (const [key, f] of [...flagged]) {
    const calAt = pairDeliveredAtMs(key);
    if (calAt !== undefined && calAt > f.since) {
      flagged.delete(key);
      console.log(`[SubscriptionWatch] ${f.entity} ${pairLabel(key)} is delivering again`);
      continue;
    }
    const rawAt = pairDeliveredAtMs(f.raw);
    if (rawAt !== undefined && now - rawAt < LIVE_MS) f.evidenceAt = now;
    if (now - f.evidenceAt > EVIDENCE_LOST_MS) flagged.delete(key);
  }

  if (flagged.size === 0) {
    if (clearAlert(STALE_SUBSCRIPTION_ALERT_KEY, now)) {
      console.log('[SubscriptionWatch] every flagged channel is delivering; alert cleared');
    }
    recoveries = 0;
    gaveUpLogged = false;
    return;
  }

  const names = staleChannels();
  if (added) {
    console.error(
      `[SubscriptionWatch] ❌ ${names.length} calibrated channel(s) silent for over ${STALE_MS / 1000} s ` +
      `while their raw channel delivers: ${names.join(', ')} — an accepted subscription that delivers nothing (D-SUB)`);
  }
  raiseAlert(
    STALE_SUBSCRIPTION_ALERT_KEY,
    'error',
    `Stale data: ${names.join(', ')} ${names.length === 1 ? 'has' : 'have'} delivered nothing for over ` +
      `${STALE_MS / 1000} s while the raw channel is live. Values shown for ${names.length === 1 ? 'it' : 'them'} are old.`,
    now,
  );

  // Reconnect only on fresh evidence this tick: right after a reconnect every pair is in its
  // grace period again, so a channel the reconnect healed is never acted on twice.
  if (stale.length === 0 || !client.isConnected()) return;
  if (recoveries >= MAX_RECOVERIES) {
    if (!gaveUpLogged) {
      console.error(
        `[SubscriptionWatch] ${names.join(', ')} still silent after ${recoveries} reconnect(s): the dead binding ` +
        'is not this backend\'s subscription (check calibration_service). Not reconnecting again.');
      gaveUpLogged = true;
    }
    return;
  }
  if (now - lastRecoveryMs < RECOVERY_MIN_INTERVAL_MS) return;
  lastRecoveryMs = now;
  recoveries++;
  console.error(
    `[SubscriptionWatch] reconnecting to Elodin to re-subscribe from scratch (${recoveries}/${MAX_RECOVERIES}): ` +
    `${stale.map((e) => `${e.entity} ${pairLabel(e.key)}`).join(', ')}`);
  clearSubscriptionState();
  client.disconnect();
  void client.connect();
}

/** Start the watch: check collisions now and on every connect, and liveness every second. */
export function startSubscriptionWatch(client: ElodinClient): NodeJS.Timeout {
  checkTableIdCollisions();
  client.on('connected', () => { checkTableIdCollisions(); });
  client.on('disconnected', () => { publisherLiveSince.clear(); });
  return setInterval(() => checkSubscriptionLiveness(client), SUBSCRIPTION_CHECK_MS);
}
