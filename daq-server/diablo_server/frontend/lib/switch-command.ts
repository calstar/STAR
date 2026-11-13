/**
 * One operator command to a Bluetooth switch, from the press to the switch's own report.
 *
 * The card shows only what the switch reported. A command is "pending" from the press until the
 * switch's reported output matches it; the env board's answer (SW<role>.cmd_id / cmd_result)
 * says whether it was even written. Pure, so the timing rules are tested without a clock.
 */

/** daq::SwitchCommandResult (lib/daq-protocol/src/DiabloPackets.h). */
export const COMMAND_RESULT_TEXT: Record<number, string> = {
  0: 'written',
  1: 'switch not connected',
  2: 'the switch did not acknowledge the write',
  3: 'no switch listed under that role on the environmental board',
  4: 'the environmental board has no switch list yet',
  5: 'the environmental board refused it (busy or malformed)',
};

/** No answer from the env board within this: the command is presumed lost. */
export const NO_ANSWER_MS = 4000;
/** Written, but the switch still reports the other state this long after the press: a fault. */
export const DISAGREE_MS = 5000;

export interface PendingCommand {
  id: number;
  output: 0 | 1;
  sentAt: number;
  /** cmd_result once the env board answered this id. */
  result: number | null;
}

export type CommandView =
  | { kind: 'none' }
  | { kind: 'waiting'; text: string }          // "Arming…"
  | { kind: 'refused'; text: string }          // not sent / not written: nothing changed
  | { kind: 'fault'; text: string };           // written, but the switch disagrees

const verb = (o: 0 | 1) => (o ? 'Arming' : 'Disarming');
const noun = (o: 0 | 1) => (o ? 'ARM' : 'DISARM');

export function commandView(p: PendingCommand | null, reportedOutput: number | null, now: number): CommandView {
  if (!p) return { kind: 'none' };
  if (p.result != null && p.result !== 0) {
    return { kind: 'refused', text: `Not sent: ${COMMAND_RESULT_TEXT[p.result] ?? `result ${p.result}`}.` };
  }
  if (reportedOutput === p.output && p.result === 0) return { kind: 'none' };
  const age = now - p.sentAt;
  if (p.result == null && age >= NO_ANSWER_MS) {
    return { kind: 'refused', text: 'No answer from the environmental board. The command may not have arrived; check the switch before pressing again.' };
  }
  if (age >= DISAGREE_MS && reportedOutput !== p.output) {
    const now_ = reportedOutput == null ? 'nothing' : reportedOutput ? 'ARMED' : 'DISARMED';
    return { kind: 'fault', text: `Commanded ${noun(p.output)}, but the switch still reports ${now_}.` };
  }
  return { kind: 'waiting', text: `${verb(p.output)}…` };
}

/** Done with it: the switch confirmed, or it was refused and the operator has seen why. */
export function commandSettled(p: PendingCommand, reportedOutput: number | null): boolean {
  return p.result === 0 && reportedOutput === p.output;
}

export function newCommandId(): number {
  return Math.floor(Math.random() * 0x10000);
}
