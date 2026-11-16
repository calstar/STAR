/**
 * server/board-status — what the backend knows about each board: the config baseline,
 * heartbeats, T7 liveness, the stale sweep and its notifications, self-test results, the
 * diagnostics log line.  [WP6 1.10, layer 3]
 *
 * Owns: `boardsStatus` (board id → `BoardStatus`), the per-board edge state of the sweep
 * (`prevConnectedState`, `boardFirstSeenSetupMs`, `t7LastMark`, `hbDiagCount`), and after step
 * 2.1 the self-test snapshot. Every decision "is board N connected" is made here: heartbeat
 * (`updateBoard`), T7 data (`noteT7Alive`), staleness (`markStaleBoards`), re-baseline
 * (`loadBoardsFromConfig`) — one owner (walkthrough (c)).
 * Must not know about: Elodin connection state, sessions (they call in through `server.ts`'s
 * callbacks), HTTP. Imports `ws-clients`, `notifications`, `stats`, `config-caches`, `env`,
 * `dhcp-status`, `routes/config`.
 * Contract: `board_status_update` (with `dhcp`, `frequencyHz`), the 5 s stale threshold
 * (`BOARD_HEARTBEAT_STALE_MS`, cited by name in `lifecycle/README.md`; bounds in
 * `lifecycle/golden/hbloss.txt`), 4 s setup-stuck, 500 ms T7 mark, the notification keys and
 * texts, the sweep's order inside one second (G11). D-SUB's future watchdog may read liveness
 * from here (`elodin-link` → `board-status` is a downward edge, WP6 [A6]); not added.
 * Import-time effects: none; `server.ts` calls `loadBoardsFromConfig()` (row 10) and registers
 * `setInterval(logDiagnostics, 5000)`, `setInterval(markStaleBoards, 1000)`,
 * `startDhcpStatusPoller()`, `setInterval(broadcastBoardStatus, 1000 / BOARD_STATUS_HZ)` — three
 * separate 1 s timers, never merged (WP6 [A5]).
 */

import type { BoardStatus, NotificationPayload, ParsedSensorData, SensorUpdate, WebSocket } from '../product-types.js';

/** 1: board status broadcasts per second. */
export declare const BOARD_STATUS_HZ: number;
/** 5000: no heartbeat for this long → disconnected. */
export declare const BOARD_HEARTBEAT_STALE_MS: number;

/** [step 1] Read by `ws-connection` (burst) and `ingest` (self-test label); private after 2.8. */
export declare const boardsStatus: Map<number, BoardStatus>;
/** [step 1] Filled by `ingest` until 2.1; replayed by `ws-connection` until 2.8. */
export declare const selfTestLatest: Map<string, SensorUpdate>;
/** [step 1] Boards already notified of a self-test failure; written by `ingest` until 2.1. */
export declare const selfTestNotifiedBoards: Set<number>;

/** Pre-populate every enabled config board as expected and disconnected (overwrites existing
 *  entries for those ids); logs `Loaded N boards from config.toml`, or warns on a config error. */
export function loadBoardsFromConfig(): void {
  throw new Error('stub');
}

/** A `[0x10, id]` heartbeat: create or update the entry (type from byte 9, unknown boards get
 *  `expected:false` and a `192.168.2.<id>` ip); broadcast at once if it was disconnected.
 *  Payloads shorter than 16 bytes are ignored. */
export function updateBoard(low: number, payload: Buffer): void {
  throw new Error('stub');
}

/** Count one heartbeat arrival for the 5 s diagnostics line. */
export function countHeartbeat(boardId: number): void {
  throw new Error('stub');
}

/** A T7 data row as its heartbeat, at most every 500 ms; only for config-declared boards. */
export function noteT7Alive(slot: number): void {
  throw new Error('stub');
}

/** The 1 s sweep: stale → disconnected; raise/clear `board_lost_`, `setup_stuck_`,
 *  `unrecognized_`; one-shot `"… connected"`; broadcast once if anything flipped. */
export function markStaleBoards(): void {
  throw new Error('stub');
}

/** Broadcast all boards with `dhcp` and `frequencyHz` filled in; no-op with no board. */
export function broadcastBoardStatus(): void {
  throw new Error('stub');
}

/** `Board <number or id> (<type>)`. */
export function boardLabel(status: BoardStatus): string {
  throw new Error('stub');
}

/** The 5 s diagnostics: heartbeat arrival rates and stats, each only when its env flag is set. */
export function logDiagnostics(): void {
  throw new Error('stub');
}

/** [step 2.1] Self-test rows `[0x60..0x6F, id]`: snapshot each; on the first failing value for a
 *  board not yet notified, raise `self_test_fail_<id>` and stop (the `break` stays). */
export function noteSelfTestResults(boardId: number, rows: ParsedSensorData[], epochNow: number): void {
  throw new Error('stub');
}

/** [step 2.8, A4] Connect burst: one `board_status_update` with the boards as stored (no
 *  dhcp/frequency recompute, as today); returns 0 when there is no board, else 1. */
export function sendBoardStatus(ws: WebSocket): number {
  throw new Error('stub');
}

/** [step 2.8, A4] Connect burst: replay each self-test SENSOR_UPDATE; returns how many. */
export function sendSelfTestReplay(ws: WebSocket): number {
  throw new Error('stub');
}

/**
 * [step 2.10, debate verdict] One board's health notifications for this sweep (server.ts:671-717),
 * in today's order: `board_lost_` raise/clear, the one-shot `"… connected"`, `setup_stuck_`
 * raise/clear (raise stamped `firstSeenSetup`), `unrecognized_` raise/clear. Today's literals and
 * key order (G9). Pure: `markStaleBoards` keeps its loop, its `const now` (:662) and every write
 * (`status.connected` :667, `boardFirstSeenSetupMs` :693/:700 — set before this call, which gets
 * the resulting `first` — the key set, `prevConnectedState` :719) and `broadcastBoardStatus()`
 * (:721), and sends each returned payload (verdict F5: the sweep is not a pure reducer).
 */
export function boardHealthEvents(
  status: Readonly<BoardStatus>,
  prev: boolean | undefined,
  firstSeenSetup: number | undefined,
  activeKeys: ReadonlySet<string>,
  now: number,
): NotificationPayload[] {
  throw new Error('stub');
}

/**
 * [step 2.10, debate verdict] The `self_test_fail_<boardId>` payload (`ongoing:true`, `<label>
 * failed self-test`, stamped `now`) for the first failing row of a board not in `notified`, else
 * `null` (server.ts:1679-1689). Pure: `noteSelfTestResults` keeps the `selfTestLatest` snapshot
 * writes (up to the failing row; the `break` stays), `selfTestNotifiedBoards.add`, the send and the
 * key; `now` is the caller's `epochNow` (:1670); `label` is computed by the caller first (a listed
 * non-verbatim edit). Return type inferred by DESIGN-WP6 (the verdict gave the parameters).
 */
export function selfTestFailure(
  boardId: number,
  rows: ReadonlyArray<ParsedSensorData>,
  notified: ReadonlySet<number>,
  label: string,
  now: number,
): NotificationPayload | null {
  throw new Error('stub');
}
