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

import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CheckoutControl } from '../src/CheckoutControl';
import type { Checkout } from '../src/useCheckout';

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

/**
 * The parts `renderToStaticMarkup` cannot reach: what the buttons actually do.
 */
describe('the chip s controls', () => {
  afterEach(cleanup);

  it('offers Keep editing only near expiry, and it refreshes the hold', async () => {
    const keepAlive = vi.fn(async () => {});
    render(<CheckoutControl checkout={{ ...base, held: true, secondsLeft: 90, keepAlive }} noun="design" />);

    await userEvent.click(screen.getByRole('button', { name: /keep editing/i }));

    expect(keepAlive).toHaveBeenCalledOnce();
  });

  it('hides Keep editing while there is plenty of time', () => {
    render(<CheckoutControl checkout={{ ...base, held: true, secondsLeft: 600 }} noun="design" />);
    expect(screen.queryByRole('button', { name: /keep editing/i })).toBeNull();
  });

  it('releases on demand', async () => {
    const release = vi.fn(async () => {});
    render(<CheckoutControl checkout={{ ...base, held: true, secondsLeft: 600, release }} noun="design" />);

    await userEvent.click(screen.getByRole('button', { name: /^release$/i }));

    expect(release).toHaveBeenCalledOnce();
  });

  it('takes a free design, and asks about notifications on that click', async () => {
    // The permission prompt needs a user gesture, and asking on page load is what trains
    // people to deny. Take is the one deliberate moment to ask.
    const requestPermission = vi.fn();
    vi.stubGlobal('Notification', class {
      static permission = 'default';
      static requestPermission = requestPermission;
    });
    const take = vi.fn(async () => {});
    render(<CheckoutControl checkout={{ ...base, held: false, holder: null, holderName: null, take }} noun="design" />);

    await userEvent.click(screen.getByRole('button', { name: /^take$/i }));

    expect(take).toHaveBeenCalledOnce();
    expect(requestPermission).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
