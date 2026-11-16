/**
 * sequencer-client — one request/reply exchange with sequencer_service on TCP :9998.  [WP5, new]
 *
 * Owns: the :9998 port (`SEQUENCER_PORT`) and the exchange (connect, write one line, read one
 * line, 2 s timeout). Holds no state between calls; one TCP connection per call; no retry, no
 * queue, no reuse.
 *
 * Must not know about: WebSocket clients, message types, which commands exist, what a refusal
 * means (callers format it with `refusal-text.ts`), sessions. It must not import `server/*` or
 * `api/*` (STYLE-S31); it imports only `net`.
 *
 * Contract surfaces (frozen, D5): the line bytes the caller passes; the reply predicate
 * (`OK` or `OK:<ms>`); the 2 s timeout; the log lines `[ThinServer] → actuator_service: <line>`
 * and `[ThinServer] actuator_service connect error: <msg>` (STYLE-S15). Guarded by
 * `pipeline/golden/ws_events.txt` (refusals) and G4 (DESIGN-WP6 §7; extended by DESIGN-WP5 §6 with
 * an accepted hold): sequencer stopped, stalled, and an `OK:<ms>` reply.
 *
 * Import-time effects: none (STYLE-S30) — `SEQUENCER_PORT` is computed from `process.env`.
 *
 * Moved verbatim from `server.ts:1411-1441` (`sendToActuatorService`), renamed. The dead :9999
 * sender is deleted, not generalised (STYLE-S35, D39).
 */

/**
 * The sequencer's command port: `ACTUATOR_SERVICE_PORT`, default 9998. The env var keeps its
 * historical name (STYLE-S7); `server.ts` imports this for its `Actuator service: localhost:<port>`
 * startup log line.
 */
export declare const SEQUENCER_PORT: number;

/** What one exchange produced. `reply` is the trimmed reply line, or the failure text. */
export interface SequencerReply {
  /** `reply === 'OK' || reply.startsWith('OK:')` (a hold answers `OK:<accepted_ms>`). */
  ok: boolean;
  /** The sequencer's reply (`OK`, `OK:<ms>`, `ERR:<reason>`), or `err.message`, `'connection
   *  closed'` or `'timeout'`. */
  reply: string;
}

/**
 * Send one command line to the sequencer and resolve with its reply.
 *
 * @param line the full command including its trailing `\n` (e.g. `'TRANSITION:Fire\n'`,
 *   `'SCRIPTS\n'`); written as given.
 *
 * Side effects: opens a TCP connection to `127.0.0.1:SEQUENCER_PORT` (host fixed); on connect
 * logs `[ThinServer] → actuator_service: <line.trim()>` and writes `line`.
 *
 * Resolution — exactly once (a latch), and **never rejects** (STYLE-S14):
 * - first `\n` in the reply → `{ ok: <predicate>, reply: <trimmed> }`, socket destroyed;
 * - `close` before that → `{ ok: false, reply: <partial reply> || 'connection closed' }`;
 * - `error` → warns `[ThinServer] actuator_service connect error: <msg>`, then
 *   `{ ok: false, reply: err.message }` (e.g. `connect ECONNREFUSED 127.0.0.1:9998`);
 * - 2000 ms without a reply line → socket destroyed, `{ ok: false, reply: 'timeout' }`.
 *
 * Callers' existing `.catch(() => {})` (debug_mode, the SCRIPTS poll) are dead but kept
 * (DESIGN-WP6 §4.2: promise shapes are not changed in a refactor).
 */
export function sendToSequencer(line: string): Promise<SequencerReply> {
  throw new Error('stub');
}
