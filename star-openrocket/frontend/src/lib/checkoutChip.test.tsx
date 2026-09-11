/**
 * The checkout chip's rendered text, pinned where it is cheap to check.
 *
 * EngineDesign's Playwright suite drives the checkout by polling for
 * `getByText('Editing', { exact: true })`. Appending the countdown as a bare
 * sibling made the chip read "Editing · 14:59", the exact-text locator stopped
 * matching, and three E2E specs failed on a timeout 30 s at a time — a slow and
 * very indirect way to learn that a label changed.
 *
 * `renderToStaticMarkup` needs no DOM, so this repo's existing vitest setup can
 * hold the contract that the E2E depends on.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CheckoutControl } from '@stardesign-ui/CheckoutControl';
import type { Checkout } from '@stardesign-ui/useCheckout';

const base: Checkout = {
  holder: 'me@berkeley.edu',
  holderName: 'Me',
  held: true,
  busy: false,
  error: null,
  take: async () => {},
  release: async () => {},
  lost: () => {},
  keepAlive: async () => {},
  expiresAt: null,
  secondsLeft: null,
  lostUnexpectedly: false,
  acknowledgeLost: () => {},
};

const markup = (c: Partial<Checkout>) =>
  renderToStaticMarkup(<CheckoutControl checkout={{ ...base, ...c }} noun="design" />);

describe('the checked-out chip', () => {
  it('keeps "Editing" as its own element once a countdown is shown', () => {
    // This exact substring is what `getByText('Editing', { exact: true })`
    // resolves against. Inlining the countdown beside a bare text node breaks it.
    expect(markup({ held: true, secondsLeft: 899 })).toContain('<span>Editing</span>');
  });

  it('still does with no countdown at all', () => {
    expect(markup({ held: true, secondsLeft: null })).toContain('<span>Editing</span>');
  });

  it('renders the countdown separately, as m:ss', () => {
    const html = markup({ held: true, secondsLeft: 899 });
    expect(html).toContain('14:59');
    expect(html).not.toContain('Editing · 14:59'); // never one run of text
  });

  it('offers Keep editing only near expiry', () => {
    expect(markup({ held: true, secondsLeft: 90 })).toContain('Keep editing');
    expect(markup({ held: true, secondsLeft: 600 })).not.toContain('Keep editing');
  });

  it('leaves the other states alone', () => {
    const readOnly = markup({ held: false, holder: null, holderName: null });
    expect(readOnly).toContain('Read only');
    expect(readOnly).not.toContain('Editing');
    expect(markup({ held: false })).toContain('is editing'); // someone else holds it
  });
});
