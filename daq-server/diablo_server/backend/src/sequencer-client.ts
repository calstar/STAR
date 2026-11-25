/**
 * sequencer-client — one request/reply exchange with sequencer_service on TCP :9998.
 *
 * Owns: the :9998 port (`SEQUENCER_PORT`) and the exchange (connect, write one line, read one
 * line, 2 s timeout). Holds no state between calls; one TCP connection per call; no retry, no
 * queue, no reuse.
 *
 * Must not know about: WebSocket clients, message types, which commands exist, what a refusal
 * means (callers format it with `refusal-text.ts`), sessions. It imports only `net`.
 *
 * Contract surfaces (frozen): the line bytes the caller passes; the reply predicate (`OK` or
 * `OK:<ms>`); the 2 s timeout; the log lines `[ThinServer] → actuator_service: <line>` and
 * `[ThinServer] actuator_service connect error: <msg>`. Guarded by the pipeline goldens
 * (`test/characterization/pipeline/golden/<mode>/ws_events.txt`: the refusals, and the `holds` mode's
 * accepted hold, timeout and ECONNREFUSED replies).
 *
 * Import-time effects: none — `SEQUENCER_PORT` is computed from `process.env`.
 *
 * Moved verbatim from `server.ts` (`sendToActuatorService`), renamed. The env var and the log
 * texts keep their historical `actuator_service` name.
 */

import * as net from 'net';

/**
 * The sequencer's command port: `ACTUATOR_SERVICE_PORT`, default 9998. `server.ts` imports this
 * for its `Actuator service: localhost:<port>` startup log line.
 */
export const SEQUENCER_PORT = parseInt(process.env.ACTUATOR_SERVICE_PORT ?? '9998', 10);

/**
 * Send one command line to the sequencer and resolve with its reply.
 *
 * @param line the full command including its trailing `\n` (e.g. `'TRANSITION:Fire\n'`,
 *   `'SCRIPTS\n'`); written as given.
 * @returns `ok` is `reply === 'OK' || reply.startsWith('OK:')` (a hold answers `OK:<accepted_ms>`);
 *   `reply` is the trimmed reply line (`OK`, `OK:<ms>`, `ERR:<reason>`) or the failure text
 *   (`err.message`, `'connection closed'`, `'timeout'`).
 *
 * Side effects: opens a TCP connection to `127.0.0.1:SEQUENCER_PORT` (host fixed); on connect
 * logs `[ThinServer] → actuator_service: <line.trim()>` and writes `line`.
 *
 * Resolution — exactly once (a latch). Socket errors and the timeout resolve `{ ok: false }`:
 * - first `\n` in the reply → `{ ok: <predicate>, reply: <trimmed> }`, socket destroyed;
 * - `close` before that → `{ ok: false, reply: <partial reply> || 'connection closed' }`;
 * - `error` → warns `[ThinServer] actuator_service connect error: <msg>`, then
 *   `{ ok: false, reply: err.message }` (e.g. `connect ECONNREFUSED 127.0.0.1:9998`);
 * - 2000 ms of socket inactivity → socket destroyed, `{ ok: false, reply: 'timeout' }`.
 *
 * It rejects when the port is invalid: a non-numeric `ACTUATOR_SERVICE_PORT` makes
 * `SEQUENCER_PORT` NaN and `net.connect` throws ERR_SOCKET_BAD_PORT synchronously inside the
 * executor, so the promise rejects before any socket exists (defect D-SEQPORT, LEDGER D93, kept
 * as is). Callers' `.catch(() => {})` (debug_mode, the SCRIPTS poll) are kept: promise shapes are
 * not changed in a refactor.
 */
export function sendToSequencer(line: string): Promise<{ ok: boolean; reply: string }> {
  return new Promise((resolve) => {
    let replyData = '';
    let resolved = false;
    const done = (ok: boolean, reply: string) => {
      if (resolved) return;
      resolved = true;
      resolve({ ok, reply });
    };
    const socket = net.connect({ host: '127.0.0.1', port: SEQUENCER_PORT }, () => {
      console.log(`[ThinServer] → actuator_service: ${line.trim()}`);
      socket.write(line);
    });
    socket.on('data', (data) => {
      replyData += data.toString();
      if (replyData.includes('\n')) {
        socket.destroy();
        const reply = replyData.trim();
        // A hold transition answers OK:<accepted_ms> so the client can show the window the
        // sequencer actually used rather than the one it asked for.
        done(reply === 'OK' || reply.startsWith('OK:'), reply);
      }
    });
    socket.on('close', () => done(false, replyData.trim() || 'connection closed'));
    socket.on('error', (err) => {
      console.warn(`[ThinServer] actuator_service connect error: ${err.message}`);
      done(false, err.message);
    });
    socket.setTimeout(2000, () => { socket.destroy(); done(false, 'timeout'); });
  });
}
