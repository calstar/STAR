import { describe, expect, it } from 'vitest';
import { fixed } from './api';

describe('a number on the screen', () => {
  it('reads with its places and thousands grouped, and a vented zero as 0', () => {
    expect(fixed(4514.66, 1)).toBe('4,514.7');
    expect(fixed(-0.04, 1)).toBe('0.0');
  });

  it('shows a value it does not have as a dash, never "NaN"', () => {
    // The Study table printed NaN in the impulse, thrust and O/F of a case that
    // failed (its outcome is {}), beside cells of the same row reading "–".
    expect(fixed(NaN, 0)).toBe('–');
    expect(fixed(Infinity, 3)).toBe('–');
    expect(fixed(undefined as unknown as number, 0)).toBe('–');
  });
});
