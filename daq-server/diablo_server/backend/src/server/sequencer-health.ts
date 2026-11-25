/**
 * server/sequencer-health.ts — the backend's watch on the sequencer's command worker (issue #234).
 *
 * The sequencer runs every state-machine command on one worker thread, and a supervisor thread
 * there reports when that worker has been inside one command past [sequencer].wedge_threshold_ms
 * (CommandQueue.hpp). This module polls the read-only `HEALTH` query on :9998 once a second while
 * the pipeline is expected to be up, and raises the keyed alert `sequencer_wedged` on
 * `HEALTH:WEDGED:<ms>`, clearing it on `HEALTH:OK` or when the sequencer is gone (connection
 * refused). No reply in time changes nothing: a stalled process is not evidence either way.
 *
 * It only observes. Nothing here, or in the sequencer's supervisor, moves a valve or restarts
 * anything (STYLE-S11a, S14a); the boards' own heartbeat watchdog is a separate layer (D-HB).
 *
 * Event-loop only. No effect at import: server.ts calls startSequencerHealthWatch().
 */

import { sendToSequencer, type SequencerReply } from '../sequencer-client.js';
import { raiseAlert, clearAlert } from './notifications.js';

export const SEQUENCER_WEDGED_ALERT_KEY = 'sequencer_wedged';

/** How often HEALTH is asked. The sequencer's threshold is seconds; this keeps the alert prompt. */
export const SEQUENCER_HEALTH_POLL_MS = 1000;

/** One HEALTH reply (or failure). Raises or clears the alert on an edge; anything else is ignored. */
export function noteSequencerHealth(r: SequencerReply, now: number = Date.now()): void {
  const reply = (r.reply ?? '').trim();
  const wedged = /^HEALTH:WEDGED:(\d+)$/.exec(reply);
  if (wedged) {
    raiseAlert(
      SEQUENCER_WEDGED_ALERT_KEY,
      'error',
      `Sequencer wedged: its command worker has been inside one command for ${(Number(wedged[1]) / 1000).toFixed(1)} s — ` +
        'new commands, aborts included, are not running. Detection only: no valve was moved.',
      now,
    );
  } else if (reply === 'HEALTH:OK' || reply.includes('ECONNREFUSED')) {
    clearAlert(SEQUENCER_WEDGED_ALERT_KEY, now);
  }
}

/**
 * Start the 1 s poll. `expected` gates it (between runs the sequencer is stopped on purpose);
 * one HEALTH is in flight at a time, so a stalled sequencer does not pile up connections.
 */
export function startSequencerHealthWatch(
  expected: () => boolean,
  ask: (line: string, opts: { quiet: boolean }) => Promise<SequencerReply> = sendToSequencer,
): NodeJS.Timeout {
  let inFlight = false;
  return setInterval(() => {
    if (inFlight || !expected()) return;
    inFlight = true;
    ask('HEALTH\n', { quiet: true })
      .then((r) => noteSequencerHealth(r))
      .catch(() => { /* bad port (D-SEQPORT): nothing to watch */ })
      .finally(() => { inFlight = false; });
  }, SEQUENCER_HEALTH_POLL_MS);
}
