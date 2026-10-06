import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ChangeRecord } from '../../../../api/layerx';

/**
 * The checkout, as the design bar's ReadOnlyProvider reports it (this suite does not alias the shared UI).
 * A .ts file, drawn with createElement: lib/gating.test.ts audits every .tsx under components/ whose
 * path names a write, and would read this file's expectations as controls.
 */
const checkout = vi.hoisted(() => ({ readOnly: true }));
vi.mock('@stardesign-ui', () => ({ useReadOnly: () => checkout.readOnly }));

const { DesignWrite } = await import('./DesignWrite');

const HOLES: ChangeRecord = {
  component: 'LOX injector holes', pid_node_id: null, field: 'd_jet', before: 1.7, after: 1.6764, unit: 'mm', provenance: 'catalog',
  effect: { of_mean: -0.02 }, cad_impact: 'new plate', target: 'design:oxidizer.d_jet', domain: 'design', source: 'catalog',
};
const WRITE = { method: 'PUT', path: '/api/config', query: { expect_sha256: 'a'.repeat(64) }, body: { injector: { geometry: { oxidizer: { d_jet: 0.0016764 } } } }, requires_confirmation: true };

describe('the design write', () => {
  it('is shut while the design is read only: every control, natively, through the fieldset', () => {
    checkout.readOnly = true;
    const html = renderToStaticMarkup(createElement(DesignWrite, { write: WRITE, changes: [HOLES], designName: 'Ethalox 7200N Doublet' }));
    expect(html).toMatch(/<fieldset disabled=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Write into the design…<\/button>/);
    expect(html).toContain('Read only: take the design to write it.');
  });

  it('is live with the checkout, and asks before it writes (the first click only opens the confirmation)', () => {
    checkout.readOnly = false;
    const html = renderToStaticMarkup(createElement(DesignWrite, { write: WRITE, changes: [HOLES], designName: 'Ethalox 7200N Doublet' }));
    expect(html).not.toMatch(/<fieldset disabled/);
    expect(html).toMatch(/<button[^>]*>Write into the design…<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Write into the design…/);
    // Nothing is written by rendering, and there is no direct write button before the confirmation.
    expect(html).not.toMatch(/>Write into the design<\/button>/);
  });
});
