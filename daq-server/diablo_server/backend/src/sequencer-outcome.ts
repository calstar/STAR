/**
 * sequencer-outcome — whether a :9998 reply says what happened, and what to tell the operator when
 * it does not (D-LATE, issue #234).
 *
 * The sequencer answers every command truthfully: `OK`, `ERR:<refusal>`, `ERR:not executed: …`
 * (cancelled at its deadline; it will never run) — all of which are known outcomes — or
 * `ERR:pending: …` (its worker has not finished, or an abort is still queued and will run). The
 * backend's own deadline firing (`timedOut`) means only that no reply arrived. In those last two
 * cases the outcome is unknown: the operator is told "state unknown, resyncing" and the published
 * state (`_SEQUENCER_STATE`, engine-state's applySequencerState) is the truth, never "failed".
 *
 * Pure. Imports only refusal-text and sequencer-client's constants.
 */

import { refusalText } from './refusal-text.js';
import { SEQUENCER_REPLY_DEADLINE_MS } from './sequencer-client.js';

export interface ReplyLike { reply: string; timedOut?: boolean }

/** True when the reply does not say whether the command ran. */
export function outcomeUnknown(r: ReplyLike): boolean {
  return r.timedOut === true || (r.reply ?? '').trim().startsWith('ERR:pending:');
}

/** The operator's text for an unknown outcome. `action` is e.g. "State transition". */
export function resyncText(action: string, r: ReplyLike): string {
  const why = r.timedOut
    ? `no reply from the sequencer within ${SEQUENCER_REPLY_DEADLINE_MS / 1000} s`
    : `the sequencer has not finished it (${refusalText(r.reply).replace(/^pending:\s*/, '')})`;
  return `${action}: ${why} — state unknown, resyncing from the published state`;
}
