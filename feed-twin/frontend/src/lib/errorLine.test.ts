import { describe, expect, it } from 'vitest';
import { NO_ERROR, errorLine, errorText, type ErrorEvent, type ErrorLine } from './errorLine';

const run = (...events: ErrorEvent[]): ErrorLine => events.reduce(errorLine, NO_ERROR);
const ticks = (n: number): ErrorEvent[] => Array.from({ length: n }, () => ({ kind: 'tick-ok' }) as const);

describe('the console error line', () => {
  it('a refusal outlives the ticks that follow it', () => {
    const refused = 'Read only: take the stand (top bar) to change its settings. Running it is not locked.';
    expect(errorText(run({ kind: 'said', text: refused }, ...ticks(50)))).toBe(refused);
  });
  it('and goes when the operator next does something that works, or dismisses it', () => {
    expect(errorText(run({ kind: 'said', text: 'Refused.' }, { kind: 'acted' }))).toBe('');
    expect(errorText(run({ kind: 'said', text: 'Refused.' }, { kind: 'dismissed' }))).toBe('');
  });
  it('a failed tick goes when one lands again', () => {
    expect(errorText(run({ kind: 'tick-failed', text: 'The server refused it (502).' }))).toBe(
      'The server refused it (502).',
    );
    expect(errorText(run({ kind: 'tick-failed', text: 'The server refused it (502).' }, ...ticks(1)))).toBe('');
  });
  it('a stand replaced after a restart says so once it has opened, and the ticks keep it', () => {
    const fresh = 'This is a fresh stand. No session 1a2b3c.';
    expect(errorText(run({ kind: 'opened', carried: fresh }, ...ticks(20)))).toBe(fresh);
  });
  it('another stand opening with nothing to say clears it', () => {
    expect(errorText(run({ kind: 'said', text: 'Refused.' }, { kind: 'opened', carried: '' }))).toBe('');
  });
});
