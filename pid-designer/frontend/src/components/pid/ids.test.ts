import { describe, expect, it } from 'vitest';
import { freshEdgeId } from './ids';

describe('a line id nothing else has', () => {
  it('is the natural name when that is free', () => {
    expect(freshEdgeId('a-b', new Set(['a-c']))).toBe('a-b');
  });

  it('numbers past every name already taken', () => {
    expect(freshEdgeId('a-b', new Set(['a-b', 'a-b-2']))).toBe('a-b-3');
  });

  it('asks a question when handed one, so a caller can count ids it has not written yet', () => {
    const minted = new Set(['a-b']);
    expect(freshEdgeId('a-b', id => id === 'a-b' || id === 'a-b-2' || minted.has(id))).toBe('a-b-3');
  });
});
