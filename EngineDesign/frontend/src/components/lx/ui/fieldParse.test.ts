import { describe, expect, it } from 'vitest';
import { editText, fieldError, parseNumber, sameAtDigits } from './fieldParse';

describe('parseNumber', () => {
  it('reads what a person types or pastes', () => {
    expect(parseNumber('578')).toEqual({ kind: 'number', value: 578 });
    expect(parseNumber(' 1,234.5 ')).toEqual({ kind: 'number', value: 1234.5 });
    expect(parseNumber('\u22123.2')).toEqual({ kind: 'number', value: -3.2 });
    expect(parseNumber('+2')).toEqual({ kind: 'number', value: 2 });
    expect(parseNumber('4.5e2')).toEqual({ kind: 'number', value: 450 });
    expect(parseNumber('.5')).toEqual({ kind: 'number', value: 0.5 });
    expect(parseNumber('4.')).toEqual({ kind: 'number', value: 4 });
  });

  it('is strict about anything that is not a number', () => {
    expect(parseNumber('')).toEqual({ kind: 'empty' });
    expect(parseNumber('   ')).toEqual({ kind: 'empty' });
    for (const t of ['12abc', 'abc', '1.2.3', '-', '.', 'e5', 'Infinity', 'NaN', '0x10', '1e999']) {
      expect(parseNumber(t).kind, t).toBe('invalid');
    }
  });
});

describe('editText and sameAtDigits', () => {
  it('prints at the field\'s digits with no grouping', () => {
    expect(editText(6804.4, 0)).toBe('6804');
    expect(editText(39.88, 1)).toBe('39.9');
    expect(editText(-0.004, 1)).toBe('0.0');
    expect(editText(null, 2)).toBe('');
  });

  it('treats values that print the same as the same', () => {
    expect(sameAtDigits(578.4, 578.2, 0)).toBe(true);
    expect(sameAtDigits(578.4, 579, 0)).toBe(false);
    expect(sameAtDigits(null, undefined, 0)).toBe(true);
    expect(sameAtDigits(null, 0, 0)).toBe(false);
  });
});

describe('fieldError', () => {
  const rules = { min: 0, max: 1000, unit: 'psig', digits: 0 };
  it('passes a value in range', () => {
    expect(fieldError(parseNumber('578'), rules)).toBeNull();
  });
  it('says what is wrong, in the field\'s unit', () => {
    expect(fieldError(parseNumber('abc'), rules)).toBe('Not a number');
    expect(fieldError(parseNumber(''), rules)).toBe('Needs a value');
    expect(fieldError(parseNumber('-5'), rules)).toBe('At least 0\u00a0psig');
    expect(fieldError(parseNumber('1200'), rules)).toBe('At most 1,000\u00a0psig');
  });
  it('allows blank only when asked, and runs the caller\'s own rule last', () => {
    expect(fieldError(parseNumber(''), { ...rules, allowEmpty: true })).toBeNull();
    const even = (v: number | null) => (v !== null && v % 2 ? 'Must be even' : null);
    expect(fieldError(parseNumber('3'), { ...rules, validate: even })).toBe('Must be even');
    expect(fieldError(parseNumber('4'), { ...rules, validate: even })).toBeNull();
  });
});
