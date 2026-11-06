/**
 * A run's operator sequence, as a person reads it.
 *
 * A run record's `inputs.sequence` is what the operator commanded between
 * Fire and the end of the burn -- an abort, a vent, a valve, a knob -- at its
 * T+ from Fire (`feed-twin/backend/main.py _burn_sequence`). Compare listed it
 * as "1 item", which says that something was commanded but not what: beside
 * a 111 % thrust change, the abort is the answer (H062).
 */
import { fixed } from '../api';
import { fmtP } from './pressure';

export interface SequenceStep {
  /** Seconds from the Fire command. */
  t: number;
  /** The command as the console sent it: `state`, `valve`/`open`,
   *  `release`, `knob` ({id, value} psig), `dome` (psig), `setup`. */
  command: Record<string, unknown>;
}

/** Whether a recorded value is a run's sequence. */
export const isSequence = (v: unknown): v is SequenceStep[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every(
    (x) =>
      !!x &&
      typeof x === 'object' &&
      typeof (x as SequenceStep).t === 'number' &&
      !!(x as SequenceStep).command &&
      typeof (x as SequenceStep).command === 'object',
  );

/** One step: "Engine Abort at T+1.50 s"; pressures psia (ADR 0007). */
export function stepText(step: SequenceStep): string {
  const c = step.command;
  const what: string[] = [];
  if (typeof c.state === 'string') what.push(c.state);
  if (typeof c.valve === 'string') what.push(`${c.valve} ${c.open ? 'opened' : 'shut'}`);
  if (c.release !== undefined && c.release !== null) {
    // '' or the console's Release all ('*'): every valve a person held.
    what.push(c.release === '' || c.release === '*' ? 'every valve released' : `${String(c.release)} released`);
  }
  const knob = c.knob;
  if (knob && typeof knob === 'object') {
    const { id, value } = knob as { id?: unknown; value?: unknown };
    what.push(`${String(id)} to ${typeof value === 'number' ? fmtP(value) : String(value)}`);
  }
  if (typeof c.dome === 'number') what.push(`dome to ${fmtP(c.dome)}`);
  if (c.setup && typeof c.setup === 'object') {
    what.push(`${Object.keys(c.setup as object).join(', ')} set`);
  }
  return `${what.join(', ') || 'a command'} at T+${fixed(step.t, 2)} s`;
}

/** The whole sequence, in order. */
export const sequenceText = (steps: SequenceStep[]): string => steps.map(stepText).join('; ');
