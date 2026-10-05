/**
 * DEF-01 / DEF-08: the Layer 1 "Run" on a pintle design must change the injector through the one
 * reconciling path, POST /api/config/switch, and must not carry a design-requirements table of its
 * own. Before the fix it sent PUT /api/config with {...pintle injector, type: 'impinging'} (the
 * pintle Cd 0.40/0.65 stayed on the drilled holes) and filled unset requirements from
 * IMPINGING_BASELINE_DEFAULTS (W_MOM 30000, W_SMD 2000, a 0.65-0.95 tank box).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Layer1Optimization.tsx'), 'utf8');

function body(name: string): string {
  const start = src.indexOf(`const ${name} = async`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = src.indexOf('\n  };\n', start);
  return src.slice(start, end);
}

describe('Layer 1 injector auto-switch', () => {
  it('goes through POST /config/switch, not a raw PUT', () => {
    const fn = body('ensureImpingingMode');
    expect(fn).toMatch(/switchConfig\(\{\s*injector_type:\s*'impinging'\s*\}\)/);
    expect(fn).not.toMatch(/updateConfig\(/);
  });

  it('keeps no design-requirements table of its own', () => {
    expect(src).not.toMatch(/IMPINGING_BASELINE_DEFAULTS/);
    expect(src).not.toMatch(/W_MOM:\s*30000/);
    expect(src).not.toMatch(/W_SMD:\s*2000/);
  });

  it('refuses to run when the switch reports inconsistent bindings', () => {
    const fn = body('ensureImpingingMode');
    expect(fn).toMatch(/binding_warnings/);
  });
});
