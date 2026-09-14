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
    expect(at('y = x |')).toMatchObject({ kind: 'expr' });
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
});

describe('completionsAt — suggests by slot', () => {
  const at = (src: string) => {
    const caret = src.indexOf('|');
    return completionsAt(src.replace('|', ''), caret, tables);
  };
  const texts = (src: string) => at(src)?.items.map((i) => i.text) ?? [];

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
  it('replaces the partial word, not the whole line', () => {
    const src = 'open_valve(FU';
    const r = completionsAt(src, src.length, tables)!;
    const out = applyCompletion(src, r, r.items[0]);
    expect(out.source).toBe('open_valve(FUEL_VENT');
    expect(out.caret).toBe(out.source.length);
  });

  it('a command inserts its opening paren and asks to reopen', () => {
    const r = completionsAt('', 0, tables)!;
    const openValve = r.items.find((i) => i.text === 'open_valve(')!;
    expect(openValve.reopen).toBe(true);
    expect(applyCompletion('', r, openValve).source).toBe('open_valve(');
  });

  it('keeps the rest of the line after the caret', () => {
    const src = 'open_valve(FU)';
    const r = completionsAt(src, src.length - 1, tables)!;
    expect(applyCompletion(src, r, r.items[0]).source).toBe('open_valve(FUEL_VENT)');
  });
});
