import { describe, expect, it } from 'vitest';
import { isTemplateTag, numberTag, stemOf, tagStem } from './tags';

describe('a dropped symbol gets a tag of its own', () => {
  it('fills the number in', () => {
    // The bug: every rotary valve landed as `ROT_#`, and the second one
    // tripped the duplicate-tag check on a drawing nobody had done anything
    // wrong on.
    expect(numberTag('ROT_#', [])).toBe('ROT-1');
    expect(numberTag('PT-HP_#', [])).toBe('PT-HP-1');
    expect(numberTag('TK-#', [])).toBe('TK-1');
  });

  it('never reissues one already on the drawing', () => {
    expect(numberTag('ROT_#', ['ROT-1', 'ROT-2'])).toBe('ROT-3');
  });

  it('counts past a gap rather than filling it', () => {
    // ROT-2 was deleted. A procedure written against it is about a valve that
    // is gone, and the next one placed must not inherit that name.
    expect(numberTag('ROT_#', ['ROT-1', 'ROT-3'])).toBe('ROT-4');
  });

  it('keeps stems apart', () => {
    // PT-HP-1 does not use up PT-1, and TK-1 does not use up TK-FU.
    expect(numberTag('PT_#', ['PT-HP-1', 'PT-HP-2'])).toBe('PT-1');
    expect(numberTag('TK-#', ['TK-FU', 'TK-LOX'])).toBe('TK-1');
  });

  it('is unmoved by tags people have renamed', () => {
    expect(numberTag('ROT_#', ['MV-OX', 'MV-FU', 'ROT-1'])).toBe('ROT-2');
  });

  it('leaves a label with no placeholder alone', () => {
    expect(numberTag('Section', ['Section'])).toBe('Section');
  });

  it('reads a stem off either spelling of the placeholder', () => {
    expect(stemOf('ROT_#')).toBe('ROT');
    expect(stemOf('TK-#')).toBe('TK');
    expect(stemOf('ENG')).toBe('ENG');
  });

  it('finds the stem of a tag already on the drawing', () => {
    // A copy of SOL-3 is the next SOL, not SOL-3-1.
    expect(tagStem('SOL-3')).toBe('SOL');
    expect(tagStem('PT-HP-12')).toBe('PT-HP');
    expect(tagStem('SV-LOX-VENT')).toBe('SV-LOX-VENT');
    expect(tagStem('ROT_#')).toBe('ROT');
  });

  it('can tell a template from a tag', () => {
    expect(isTemplateTag('ROT_#')).toBe(true);
    expect(isTemplateTag('ROT-1')).toBe(false);
  });
});
