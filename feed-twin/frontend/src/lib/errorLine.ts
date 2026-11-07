/**
 * The console's one error line, and what clears it. Pure, for stand.tsx;
 * tested in errorLine.test.ts.
 *
 * Two kinds of message share the line. What the stand or an action said -- a
 * refused state, valve or knob, "Read only: take the stand", a stand replaced
 * after the server forgot it -- stays until the operator next does something
 * that works, dismisses it, or another stand opens. The tick's own failure is
 * about the link, and goes the moment a tick lands again. They used to be one:
 * every successful tick (five a second) cleared the line, so a refusal showed
 * for at most 200 ms and a click on a read-only stand appeared to do nothing.
 */

export interface ErrorLine {
  /** What an action or the stand said. */
  said: string;
  /** Why the last tick failed, '' once one lands. */
  tick: string;
}

export type ErrorEvent =
  /** An action failed, or the stand has something to say. */
  | { kind: 'said'; text: string }
  /** An action the operator took went through. */
  | { kind: 'acted' }
  | { kind: 'tick-ok' }
  | { kind: 'tick-failed'; text: string }
  /** Another stand opened: the line is about it, and says what carried over
   *  ("This is a fresh stand.") or nothing. */
  | { kind: 'opened'; carried: string }
  | { kind: 'dismissed' };

export const NO_ERROR: ErrorLine = { said: '', tick: '' };

export function errorLine(line: ErrorLine, event: ErrorEvent): ErrorLine {
  switch (event.kind) {
    case 'said':
      return { ...line, said: event.text };
    case 'acted':
      return line.said ? { ...line, said: '' } : line;
    case 'tick-ok':
      return line.tick ? { ...line, tick: '' } : line;
    case 'tick-failed':
      return { ...line, tick: event.text };
    case 'opened':
      return { said: event.carried, tick: '' };
    case 'dismissed':
      return NO_ERROR;
  }
}

/** What the line shows: what was said first, the link after. */
export const errorText = (line: ErrorLine): string => line.said || line.tick;
