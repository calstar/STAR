import { describe, expect, it } from 'vitest';
import { cssColor, parseCssVar } from './color';

describe('parseCssVar', () => {
  it('reads a token in every way a chart is given one', () => {
    expect(parseCssVar('--lx-lox')).toEqual({ name: '--lx-lox' });
    expect(parseCssVar('var(--lx-lox)')).toEqual({ name: '--lx-lox' });
    expect(parseCssVar(' var( --lx-fuel , #e9a55a ) ')).toEqual({ name: '--lx-fuel', fallback: '#e9a55a' });
  });

  it('is null for a plain colour', () => {
    expect(parseCssVar('#5fb0f5')).toBeNull();
    expect(parseCssVar('rgb(1, 2, 3)')).toBeNull();
    expect(parseCssVar('red')).toBeNull();
  });
});

describe('cssColor', () => {
  it('wraps a bare token in var() and leaves the rest', () => {
    expect(cssColor('--lx-hot')).toBe('var(--lx-hot)');
    expect(cssColor('var(--lx-hot)')).toBe('var(--lx-hot)');
    expect(cssColor('#fff')).toBe('#fff');
  });
});
