import { describe, expect, it } from 'vitest';
import { commandSettled, commandView, DISAGREE_MS, NO_ANSWER_MS, type PendingCommand } from '@/lib/switch-command';

const arm = (over: Partial<PendingCommand> = {}): PendingCommand => ({ id: 7, output: 1, sentAt: 0, result: null, ...over });

describe('a switch command, from press to report', () => {
  it('waits ("Arming…") until the switch itself reports armed', () => {
    expect(commandView(arm(), 0, 100)).toEqual({ kind: 'waiting', text: 'Arming…' });
    expect(commandView(arm({ result: 0 }), 0, 1500)).toEqual({ kind: 'waiting', text: 'Arming…' });
    expect(commandView(arm({ output: 0 }), 1, 100).kind === 'waiting' && commandView(arm({ output: 0 }), 1, 100)).toEqual({ kind: 'waiting', text: 'Disarming…' });
    expect(commandView(arm({ result: 0 }), 1, 1600)).toEqual({ kind: 'none' });
    expect(commandSettled(arm({ result: 0 }), 1)).toBe(true);
  });

  it('never shows armed on the env board saying "written" alone', () => {
    expect(commandSettled(arm({ result: 0 }), 0)).toBe(false);
    expect(commandSettled(arm({ result: null }), 1)).toBe(false);  // and not before the answer
  });

  it('says why when nothing was sent', () => {
    expect(commandView(arm({ result: 1 }), 0, 50)).toEqual({ kind: 'refused', text: 'Not sent: switch not connected.' });
    expect(commandView(arm({ result: 2 }), 0, 50).kind).toBe('refused');
  });

  it('flags a lost command, then a switch that disagrees', () => {
    expect(commandView(arm(), 0, NO_ANSWER_MS).kind).toBe('refused');
    expect(commandView(arm({ result: 0 }), 0, DISAGREE_MS - 1).kind).toBe('waiting');
    expect(commandView(arm({ result: 0 }), 0, DISAGREE_MS)).toEqual({ kind: 'fault', text: 'Commanded ARM, but the switch still reports DISARMED.' });
  });
});
