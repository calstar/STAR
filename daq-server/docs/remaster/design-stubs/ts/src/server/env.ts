/**
 * server/env — the backend process's environment knobs, read once.  [WP6 1.1, layer 0]
 *
 * Owns: the values below, computed from `process.env` at import (allowed by WP6-M1 / STYLE-S30).
 * Must not know about: anything else; imports nothing.
 *
 * [A1] Not here: the :9998 port is `SEQUENCER_PORT`, owned by WP5's `sequencer-client.ts` (the
 * module that dials it); `CTRL_SVC_PORT` is deleted by WP5 (no user). `USE_SIM` stays read **per
 * call** inside `elodin-link.isSimulated()`, moved verbatim. Both are recorded as STYLE-S20
 * questions (DESIGN-WP6 "Interfaces").
 *
 * Contract: env var names are external (STYLE-S7).
 */

/** `WS_PORT`, default 8081: HTTP + WebSocket. */
export declare const WS_PORT: number;
/** `GUI_PORT`, default 3000; 0 disables the static GUI server. */
export declare const GUI_PORT: number;
/** `ELODIN_HOST`, default `127.0.0.1`. */
export declare const ELODIN_HOST: string;
/** `ELODIN_PORT`, default 2240. */
export declare const ELODIN_PORT: number;
/** `THIN_VERBOSE_CONNECTION_LOG === '1'`: board connect / T+0 / sequencer-state log lines. */
export declare const THIN_VERBOSE_CONNECTION_LOG: boolean;
/** `THIN_HEARTBEAT_DIAG_LOG === '1'`: the 5 s heartbeat arrival-rate line. */
export declare const THIN_HEARTBEAT_DIAG_LOG: boolean;
/** `THIN_STATS_LOG === '1'`: the 5 s ingest/broadcast stats line. */
export declare const THIN_STATS_LOG: boolean;
