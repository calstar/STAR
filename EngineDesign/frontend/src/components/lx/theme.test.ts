import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Read from disk: vitest hands CSS imports (even ?raw) to its CSS pipeline, which blanks them.
const css = readFileSync(fileURLToPath(new URL('./theme.css', import.meta.url)), 'utf8');

/**
 * The spec's contrast rule, checked on the tokens as shipped: text 4.5:1 (WCAG AA), chart lines and
 * status marks 3:1 (non-text, WCAG 1.4.11), on every ground they are drawn on. A token tweak that
 * makes the units unreadable on a panel fails here, not in a screenshot review.
 */

function tokens(theme: 'dark' | 'light'): Record<string, string> {
  const m = new RegExp(`\\.lx\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`no ${theme} block`);
  const out: Record<string, string> = {};
  for (const [, k, v] of m[1].matchAll(/(--lx-[\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)) out[k] = v.toLowerCase();
  return out;
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const SPEC: Record<'dark' | 'light', Record<string, string>> = {
  dark: {
    '--lx-bg': '#0c0e11', '--lx-surface': '#13161a', '--lx-surface-2': '#1a1e24', '--lx-line': '#262b33', '--lx-line-strong': '#353c47',
    '--lx-text': '#e7eaee', '--lx-text-2': '#a7afba', '--lx-text-3': '#808a98', '--lx-accent': '#8f9cff', '--lx-cursor': '#e7eaee',
    '--lx-lox': '#5fb0f5', '--lx-fuel': '#e9a55a', '--lx-gas': '#4cc3b5', '--lx-hot': '#ff7b54',
    '--lx-ok': '#3fb950', '--lx-warn': '#e3b341', '--lx-bad': '#f85149',
  },
  light: {
    '--lx-bg': '#f6f7f9', '--lx-surface': '#ffffff', '--lx-surface-2': '#f0f2f5', '--lx-line': '#e2e5ea', '--lx-line-strong': '#cdd2da',
    '--lx-text': '#13161a', '--lx-text-2': '#4a5260', '--lx-text-3': '#646d7a', '--lx-accent': '#4452d9', '--lx-cursor': '#13161a',
    '--lx-lox': '#1d6fc9', '--lx-fuel': '#a8621a', '--lx-gas': '#0d8478', '--lx-hot': '#cf4a1c',
    '--lx-ok': '#1a7f37', '--lx-warn': '#9a6700', '--lx-bad': '#cf222e',
  },
};

describe.each(['dark', 'light'] as const)('%s theme', (theme) => {
  const t = tokens(theme);

  it('carries the spec\'s tokens exactly', () => {
    for (const [k, v] of Object.entries(SPEC[theme])) expect(t[k], k).toBe(v);
  });

  it('text is AA (4.5:1) on the page, the panels and the inset ground', () => {
    const low: string[] = [];
    for (const fg of ['--lx-text', '--lx-text-2', '--lx-text-3']) {
      for (const bg of ['--lx-bg', '--lx-surface', '--lx-surface-2']) {
        const r = contrast(t[fg], t[bg]);
        if (r < 4.5) low.push(`${fg} on ${bg}: ${r.toFixed(2)}`);
      }
    }
    expect(low).toEqual([]);
  });

  it('status words and the accent are AA as text on the panels', () => {
    const low: string[] = [];
    for (const fg of ['--lx-ok', '--lx-warn', '--lx-bad', '--lx-accent']) {
      for (const bg of ['--lx-bg', '--lx-surface']) {
        const r = contrast(t[fg], t[bg]);
        if (r < 4.5) low.push(`${fg} on ${bg}: ${r.toFixed(2)}`);
      }
    }
    expect(low).toEqual([]);
  });

  it('the primary button\'s label is AA on the accent', () => {
    expect(contrast(t['--lx-on-accent'], t['--lx-accent'])).toBeGreaterThanOrEqual(4.5);
  });

  it('chart lines and marks are 3:1 against the panel', () => {
    const low: string[] = [];
    for (const fg of ['--lx-lox', '--lx-fuel', '--lx-gas', '--lx-hot', '--lx-cursor', '--lx-ok', '--lx-warn', '--lx-bad', '--lx-text-3']) {
      const r = contrast(t[fg], t['--lx-surface']);
      if (r < 3) low.push(`${fg}: ${r.toFixed(2)}`);
    }
    expect(low).toEqual([]);
  });

  it('a switch thumb reads against its track, on and off', () => {
    expect(contrast(t['--lx-on-accent'], t['--lx-accent'])).toBeGreaterThanOrEqual(3);
    expect(contrast(t['--lx-on-accent'], t['--lx-text-3'])).toBeGreaterThanOrEqual(3);
  });
});

it('the contrast function agrees with WCAG\'s own examples', () => {
  expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 6);
  expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
});
