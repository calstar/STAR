/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The drawing is pid-designer's canvas, and its symbols are coloured by
 * pid-designer's palette. This app scopes a copy of that palette to the
 * drawing (`.pid-drawing` in index.css) rather than importing the editor's
 * stylesheet, which would restyle this whole app. A copy drifts, so this holds
 * it to the editor's dark theme, value for value.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function block(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--color-[a-z-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

describe('the drawing is in pid-designer\'s colours', () => {
  it('carries every colour of the editor\'s dark theme, unchanged', () => {
    const editor = block(read('../../../../pid-designer/frontend/src/index.css'), ':root');
    const here = block(read('../index.css'), '.pid-drawing');
    expect(Object.keys(editor).length).toBeGreaterThan(5);
    expect(here).toEqual(editor);
  });
});
