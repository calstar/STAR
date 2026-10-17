import { describe, expect, it } from 'vitest';
import type { InjectorLayoutWarning } from '../api/client';
import { sortInjectorChecks, splitConfigKeys } from './injectorChecks';

const w = (level: InjectorLayoutWarning['level'], code: string, text = code): InjectorLayoutWarning => ({ level, code, text });

describe('sortInjectorChecks', () => {
  // The ethalox doublet's list, 2026-10-17 (ed-06d-injector-checks.png).
  const list = [
    w('warn', 'drawing_igniter'),
    w('bad', 'drawing_passage_O', 'LOX passage: exit 0.011 mm and length -0.090 mm off the drawing'),
    w('bad', 'drawing_passage_F'),
    w('bad', 'drawing_profile'),
    w('bad', 'igniter_groove', '3/8 NPT igniter thread cuts back groove 1'),
    w('info', 'back_lands'),
    w('warn', 'port_over_groove_O'),
    w('info', 'plate_bending'),
  ];
  const sorted = sortInjectorChecks(list);

  it('keeps the real clash with the hardware, and only it as a failure', () => {
    expect(sorted.hardware.map((x) => x.code)).toEqual(['igniter_groove', 'port_over_groove_O']);
  });
  it('groups the drawing drift apart from the hardware', () => {
    expect(sorted.drawing.map((x) => x.code)).toEqual(['drawing_igniter', 'drawing_passage_O', 'drawing_passage_F', 'drawing_profile']);
  });
  it('puts the notes in their own group', () => {
    expect(sorted.notes.map((x) => x.code)).toEqual(['back_lands', 'plate_bending']);
  });
});

describe('splitConfigKeys', () => {
  it('moves a cited config key out of the sentence', () => {
    const got = splitConfigKeys('move the port, or open it with a smaller bore (injector.plate.port_bore)');
    expect(got.text).toBe('move the port, or open it with a smaller bore');
    expect(got.keys).toEqual(['injector.plate.port_bore']);
  });
  it('leaves an ordinary parenthetical alone', () => {
    expect(splitConfigKeys('back groove 1 (r 7.65–11.18)').text).toBe('back groove 1 (r 7.65–11.18)');
  });
});
