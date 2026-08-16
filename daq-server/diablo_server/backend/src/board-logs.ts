/**
 * Board log ingestion + in-memory cache.
 *
 * Boards stream diagnostic logs to the server as type-15 LOGS packets (one per
 * board per second). daq_bridge parses them and forwards a small envelope to
 * this backend over loopback UDP:
 *
 *   [board_id:u8][flags:u8][text_len:u16 LE][text bytes]   (flags bit0 = TRUNCATED)
 *
 * We cache the recent lines in memory (a global ring buffer, arrival order) and
 * push each packet's lines to WS clients. These logs deliberately do NOT go to
 * Elodin — there is no need to replay board logs for past runs, so simple
 * server-arrival ordering (Date.now()) is used, not the board-clock timestamping
 * infrastructure. History is session-scoped: it lives only in this process.
 */

import * as dgram from 'dgram';
import { MessageType, type BoardLogLine, type BoardLogTotals } from '../../shared/types.js';

export type { BoardLogLine, BoardLogTotals } from '../../shared/types.js';

const LOG_INGEST_PORT = parseInt(process.env.LOG_INGEST_PORT || '8092', 10);

// Global ring buffer (arrival order). 16 boards × ~1 line/s → a few tens of
// minutes of history at this size. Bounds memory regardless of board count.
const GLOBAL_CAP = 4000;

const ring: BoardLogLine[] = [];
const truncatedSeen = new Map<number, boolean>();
// Cumulative per-board counters since backend start (packets, not lines):
// received = BOARD_LOG packets seen, truncated = those with the TRUNCATED flag.
const totals = new Map<number, BoardLogTotals>();

function bumpTotals(boardId: number, truncated: boolean): BoardLogTotals {
  const t = totals.get(boardId) ?? { received: 0, truncated: 0 };
  t.received += 1;
  if (truncated) t.truncated += 1;
  totals.set(boardId, t);
  return t;
}

function appendLine(entry: BoardLogLine): void {
  ring.push(entry);
  if (ring.length > GLOBAL_CAP) {
    ring.splice(0, ring.length - GLOBAL_CAP);
  }
}

type BroadcastFn = (message: object) => void;

/**
 * Bind the loopback UDP socket daq_bridge forwards board logs to, cache the
 * lines, and broadcast each packet's lines to WS clients. Always-on (does not
 * depend on a session), though logs only flow while daq_bridge is running.
 */
export function startBoardLogReceiver(broadcast: BroadcastFn): dgram.Socket {
  const sock = dgram.createSocket('udp4');

  sock.on('message', (msg: Buffer) => {
    if (msg.length < 4) return; // board_id + flags + text_len
    const boardId = msg.readUInt8(0);
    const flags = msg.readUInt8(1);
    const textLen = msg.readUInt16LE(2);
    if (msg.length < 4 + textLen) return;
    const text = msg.toString('utf8', 4, 4 + textLen);

    const truncated = (flags & 0x01) !== 0;
    if (truncated) truncatedSeen.set(boardId, true);

    // Blob is newline-delimited; drop empty lines (trailing '\n', blank spacers).
    const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
    if (lines.length === 0) return;

    // Count each packet (flush), matching the per-flush TRUNCATED flag.
    const t = bumpTotals(boardId, truncated);

    const ts = Date.now();
    for (const line of lines) {
      appendLine({ boardId, ts, line });
    }

    broadcast({
      type: MessageType.BOARD_LOG,
      timestamp: ts,
      payload: { boardId, ts, lines, truncated, totals: { ...t } },
    });
  });

  sock.on('error', (err) => {
    console.error('[board-logs] UDP socket error:', err);
  });

  sock.bind(LOG_INGEST_PORT, '127.0.0.1', () => {
    console.log(`✅ Board-log receiver listening on 127.0.0.1:${LOG_INGEST_PORT}`);
  });

  return sock;
}

export interface BoardLogHistoryQuery {
  /** Restrict to a single board_id. */
  board?: number;
  /** Return at most this many most-recent lines (default 500). */
  limit?: number;
}

/** Recent cached log lines (arrival order, oldest → newest), for backfill. */
export function getBoardLogHistory(query: BoardLogHistoryQuery = {}): {
  lines: BoardLogLine[];
  truncated: boolean;
} {
  const limit = query.limit && query.limit > 0 ? query.limit : 500;
  let lines = ring;
  if (typeof query.board === 'number') {
    lines = ring.filter((e) => e.boardId === query.board);
  }
  const sliced = lines.slice(Math.max(0, lines.length - limit));
  const truncated =
    typeof query.board === 'number'
      ? truncatedSeen.get(query.board) === true
      : Array.from(truncatedSeen.values()).some((v) => v);
  return { lines: sliced, truncated };
}

/** Cumulative per-board log counters (packets received / truncated), for backfill. */
export function getBoardLogStats(): Record<number, BoardLogTotals> {
  const out: Record<number, BoardLogTotals> = {};
  for (const [boardId, t] of totals) {
    out[boardId] = { ...t };
  }
  return out;
}
