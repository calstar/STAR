/**
 * The tokenizer and the completion source — the two pure pieces behind highlighting and
 * autocomplete.
 *
 * Both exist to enforce one rule: a name means what its SLOT says it means, not what it is
 * spelled. The case that proves it is FUEL_VENT, which on the shipped `server` profile is both a
 * valve and a state. A tokenizer that got that wrong would paint one of them the wrong colour; a
 * completer that got it wrong would offer states where only valves belong.
 */
import { describe, it, expect } from 'vitest';
import { tokenize, caretContext } from '@/lib/state-script-tokens';
import { completionsAt, applyCompletion } from '@/lib/state-script-complete';

const tables = {
  actuators: new Set(['FUEL_VENT', 'GSE_HIGH_PRESS_CONTROL', 'MAIN_VALVE']),
  sensors: new Set(['GN2_HIGH', 'GN2_REGULATED']),
  states: new Set(['IDLE', 'PRESS_STANDBY', 'FUEL_VENT', 'FIRE']),
  allowedTransitions: new Set(['IDLE', 'PRESS_STANDBY', 'FUEL_VENT']),
};

/** The kind assigned to the first token whose text matches. */
const kindOf = (src: string, text: string) =>
  tokenize(src, tables).find((t) => t.text === text)?.kind;

describe('tokenize — a name means what its slot says', () => {
  it('classifies the SAME word differently in different calls', () => {
    const src = 'open_valve(FUEL_VENT)\ntransition_to(FUEL_VENT)\n';
    const toks = tokenize(src, tables).filter((t) => t.text === 'FUEL_VENT');
    expect(toks.map((t) => t.kind)).toEqual(['valve', 'state']);
  });

  it('classifies a name inside pressure() as a sensor', () => {
    expect(kindOf('x = pressure(GN2_HIGH)\n', 'GN2_HIGH')).toBe('sensor');
  });

  it('treats a bare identifier as a variable', () => {
    expect(kindOf('target = 5\ndelay(target)\n', 'target')).toBe('variable');
  });

  it('marks built-in calls as commands and unknown calls as unknown', () => {
    expect(kindOf('open_valve(X)\n', 'open_valve')).toBe('command');
    expect(kindOf('frobnicate(X)\n', 'frobnicate')).toBe('unknown');
  });

  it('marks keywords, numbers and comments', () => {
    const src = '# note\nwhile elapsed() < 5:\n    delay(0.25)\n';
    expect(kindOf(src, 'while')).toBe('keyword');
    expect(kindOf(src, '0.25')).toBe('number');
    expect(tokenize(src, tables)[0].kind).toBe('comment');
  });

  it('flags a name config does not declare, and only that one', () => {
    const toks = tokenize('open_valve(FUEL_VNT)\nopen_valve(MAIN_VALVE)\n', tables);
    const names = toks.filter((t) => t.kind === 'valve');
    expect(names.map((t) => [t.text, t.known])).toEqual([
      ['FUEL_VNT', false],
      ['MAIN_VALVE', true],
    ]);
  });

  it('does not let an unclosed paren colour the rest of the file', () => {
    // A newline closes the call. Without that, MAIN_VALVE on the next line would read as a
    // continuation of open_valve('s argument list.
    expect(kindOf('open_valve(\nMAIN_VALVE\n', 'MAIN_VALVE')).toBe('variable');
  });

  it('handles a call nested in another call', () => {
    expect(kindOf('delay(pressure(GN2_HIGH))\n', 'GN2_HIGH')).toBe('sensor');
  });

  it('lexes two-character operators whole', () => {
    const ops = tokenize('if a <= b:\n', tables).filter((t) => t.kind === 'op').map((t) => t.text);
    expect(ops).toContain('<=');
    expect(ops).not.toContain('<');
  });
});

describe('caretContext — works on half-typed text', () => {
  const at = (src: string) => caretContext(src.replace('|', ''), src.indexOf('|'));

  it('knows it is in a valve slot before the paren is closed', () => {
    expect(at('open_valve(FU|')).toMatchObject({ kind: 'valve', prefix: 'FU' });
  });

  it('knows a sensor slot', () => {
    expect(at('x = pressure(GN|')).toMatchObject({ kind: 'sensor', prefix: 'GN' });
  });

  it('knows a state slot', () => {
    expect(at('transition_to(|')).toMatchObject({ kind: 'state', prefix: '' });
  });

  it('treats an indented line start as a command position', () => {
    expect(at('while x < 1:\n    op|')).toMatchObject({ kind: 'command', prefix: 'op' });
  });

  it('treats the right-hand side of an assignment as an expression', () => {
    expect(at('y = |')).toMatchObject({ kind: 'expr' });
  });

  it('suggests nothing inside a comment', () => {
    expect(at('# open_valve(FU|')).toBeNull();
  });

  it("delay() takes an expression, not a name", () => {
    expect(at('delay(|')).toMatchObject({ kind: 'expr' });
  });

  it('reports the range to replace, so accepting overwrites the partial word', () => {
    const ctx = at('open_valve(FUE|')!;
    expect(ctx.to - ctx.from).toBe(3);
  });

  /**
   * One statement per line is a rule of the grammar, and it decides where the popup may appear.
   *
   * After a finished call nothing else can legally go on that line — so suggesting there is not
   * just noise. The popup swallows Enter, so finishing a call and pressing Enter to start the next
   * line would insert a second command onto the same one.
   */
  describe('a completed line suggests nothing further', () => {
    it('after a finished call', () => {
      expect(at('open_valve(FUEL_VENT)|')).toBeNull();
    });

    it('after a finished call with trailing space', () => {
      expect(at('open_valve(FUEL_VENT) |')).toBeNull();
    });

    it('after a finished assignment', () => {
      expect(at('x = pressure(GN2_HIGH)|')).toBeNull();
    });

    it('even when a word is being typed after a finished call', () => {
      expect(at('open_valve(FUEL_VENT) de|')).toBeNull();
    });
  });

  describe('but still suggests where a value is genuinely expected', () => {
    it('after an assignment', () => {
      expect(at('x = |')).toMatchObject({ kind: 'expr' });
    });

    it('after an arithmetic operator', () => {
      expect(at('x = 0.9 * |')).toMatchObject({ kind: 'expr' });
    });

    it('after a comparison operator', () => {
      expect(at('while elapsed() < |')).toMatchObject({ kind: 'expr' });
    });

    it('after a condition keyword', () => {
      expect(at('if |')).toMatchObject({ kind: 'expr' });
      expect(at('while |')).toMatchObject({ kind: 'expr' });
    });

    it('after and / or / not', () => {
      expect(at('if a and |')).toMatchObject({ kind: 'expr' });
      expect(at('if not |')).toMatchObject({ kind: 'expr' });
    });

    it('after an opening paren used for grouping', () => {
      expect(at('x = (|')).toMatchObject({ kind: 'expr' });
    });

    it('while a variable name is being typed on the right of an assignment', () => {
      expect(at('y = tar|')).toMatchObject({ kind: 'expr', prefix: 'tar' });
    });
  });
});

describe('completionsAt — suggests by slot', () => {
  const at = (src: string) => {
    const caret = src.indexOf('|');
    return completionsAt(src.replace('|', ''), caret, tables);
  };
  const texts = (src: string) => at(src)?.items.map((i) => i.label ?? i.text) ?? [];

  it('offers only valves in a valve slot — even a word that is also a state', () => {
    const t = texts('open_valve(|');
    expect(t).toContain('FUEL_VENT');
    expect(t).toContain('MAIN_VALVE');
    expect(t).not.toContain('IDLE');
    expect(t).not.toContain('GN2_HIGH');
  });

  it('offers only sensors in a sensor slot', () => {
    const t = texts('x = pressure(|');
    expect(t).toEqual(['GN2_HIGH', 'GN2_REGULATED']);
  });

  it('offers only states this one can REACH', () => {
    const t = texts('transition_to(|');
    expect(t).toContain('PRESS_STANDBY');
    // FIRE is a real state but not an allowed transition — offering it would be offering a config
    // the sequencer refuses at load.
    expect(t).not.toContain('FIRE');
  });

  it('offers commands at statement start', () => {
    expect(texts('|')).toContain('open_valve(');
    expect(texts('    |')).toContain('delay(');
  });

  it('offers assigned variables and value built-ins in an expression', () => {
    const t = texts('target = 5\ndelay(tar|');
    expect(t).toContain('target');
  });

  it('does not offer a variable that is never assigned', () => {
    expect(texts('delay(zzz|')).toEqual([]);
  });

  it('filters by prefix, case-insensitively, prefix matches first', () => {
    expect(texts('open_valve(fu|')).toEqual(['FUEL_VENT']);
  });

  it('suggests nothing in a comment', () => {
    expect(at('# open_valve(|')).toBeNull();
  });
});

describe('applyCompletion', () => {
  /**
   * Every name-taking built-in has exactly ONE argument, so choosing the name finishes the call —
   * there is nothing the paren could still be waiting for. Closing it here saves the operator a
   * keystroke and, more importantly, removes an unclosed paren that would otherwise be a parse
   * error they had to come back and fix.
   */
  it('closes the call after a valve, leaving the caret past the paren', () => {
    const src = 'open_valve(FU';
    const r = completionsAt(src, src.length, tables)!;
    const out = applyCompletion(src, r, r.items[0]);
    expect(out.source).toBe('open_valve(FUEL_VENT)');
    expect(out.caret).toBe(out.source.length);
  });

  it('closes the call after a sensor and after a state too', () => {
    const s1 = 'x = pressure(';
    const r1 = completionsAt(s1, s1.length, tables)!;
    expect(applyCompletion(s1, r1, r1.items[0]).source).toBe('x = pressure(GN2_HIGH)');

    // items are sorted, so [0] here is FUEL_VENT — which is also a valve, and is exactly the case
    // that proves the state slot is resolved by position rather than by spelling.
    const s2 = 'transition_to(';
    const r2 = completionsAt(s2, s2.length, tables)!;
    expect(applyCompletion(s2, r2, r2.items[0]).source).toBe('transition_to(FUEL_VENT)');
  });

  it('does NOT double the paren when one is already there', () => {
    const src = 'open_valve(FU)';
    const r = completionsAt(src, src.length - 1, tables)!;
    expect(applyCompletion(src, r, r.items[0]).source).toBe('open_valve(FUEL_VENT)');
  });

  it('shows the bare name in the list while inserting the closing paren', () => {
    const src = 'open_valve(';
    const r = completionsAt(src, src.length, tables)!;
    // What the operator reads is the name; what lands is the name plus its paren.
    expect(r.items[0].label).toBe('FUEL_VENT');
    expect(r.items[0].text).toBe('FUEL_VENT)');
  });

  it('filters on the visible name, not on the inserted punctuation', () => {
    const src = 'open_valve(fuel';
    const r = completionsAt(src, src.length, tables)!;
    expect(r.items.map((i) => i.label)).toEqual(['FUEL_VENT']);
  });

  it('a command inserts its opening paren and asks to reopen', () => {
    const r = completionsAt('', 0, tables)!;
    const openValve = r.items.find((i) => i.text === 'open_valve(')!;
    expect(openValve.reopen).toBe(true);
    expect(applyCompletion('', r, openValve).source).toBe('open_valve(');
  });

  it('the two steps compose into a finished, closed statement', () => {
    // Pick the command, then the name — the flow an operator actually types.
    const r1 = completionsAt('', 0, tables)!;
    const step1 = applyCompletion('', r1, r1.items.find((i) => i.text === 'open_valve(')!);
    const r2 = completionsAt(step1.source, step1.caret, tables)!;
    const step2 = applyCompletion(step1.source, r2, r2.items[0]);
    expect(step2.source).toBe('open_valve(FUEL_VENT)');
    // And the line is now complete, so nothing further is offered on it — Enter makes a new line.
    expect(completionsAt(step2.source, step2.caret, tables)).toBeNull();
  });
});
