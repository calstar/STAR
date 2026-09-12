/**
 * The notice shown when a checkout goes away without the user releasing it.
 *
 * Losing a design used to be silent: the canvas quietly stopped accepting edits and the
 * only signal was a save failing, so people kept working into a void. The whole point of
 * this dialog is to still be there when you come back, which means the title mutation and
 * the restore-on-unmount are as load-bearing as the markup — and none of it is reachable by
 * `renderToStaticMarkup`, which is why these tests need a DOM.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CheckoutLostDialog } from '../src/CheckoutControl';
import type { Checkout } from '../src/useCheckout';

const base: Checkout = {
  holder: null,
  holderName: null,
  held: false,
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

const lost = (over: Partial<Checkout> = {}): Checkout => ({
  ...base,
  lostUnexpectedly: true,
  ...over,
});

let originalTitle: string;
beforeEach(() => {
  originalTitle = 'STAR OpenRocket';
  document.title = originalTitle;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('when nothing has been lost', () => {
  it('renders nothing at all', () => {
    const { container } = render(<CheckoutLostDialog checkout={base} noun="design" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('leaves the tab title alone', () => {
    render(<CheckoutLostDialog checkout={base} noun="design" />);
    expect(document.title).toBe(originalTitle);
  });
});

describe('when the hold has gone', () => {
  it('says so, and offers the design back', () => {
    render(<CheckoutLostDialog checkout={lost()} noun="design" />);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /take it back/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stay read only/i })).toBeInTheDocument();
  });

  it('names whoever has it now, when somebody does', () => {
    render(<CheckoutLostDialog checkout={lost({ holderName: 'Dana' })} noun="design" />);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Dana');
  });

  it('marks the tab, so it is visible from another one', () => {
    // The dialog only helps if you are looking at the page. The title is what reaches
    // someone who is in a different tab entirely.
    render(<CheckoutLostDialog checkout={lost()} noun="design" name="Booster v3" />);
    expect(document.title).toContain('Checkout lost');
  });

  it('puts the title back when it goes away', () => {
    // Captured per activation rather than at module scope, so the app renaming its own
    // title mid-session does not get clobbered.
    const view = render(<CheckoutLostDialog checkout={lost()} noun="design" />);
    expect(document.title).not.toBe(originalTitle);
    view.unmount();
    expect(document.title).toBe(originalTitle);
  });
});

describe('the buttons', () => {
  it('takes the design back and then clears the notice', async () => {
    const take = vi.fn(async () => {});
    const acknowledgeLost = vi.fn();
    render(<CheckoutLostDialog checkout={lost({ take, acknowledgeLost })} noun="design" />);

    await userEvent.click(screen.getByRole('button', { name: /take it back/i }));

    expect(take).toHaveBeenCalledOnce();
    expect(acknowledgeLost).toHaveBeenCalledOnce();
  });

  it('dismisses without taking anything when the user declines', async () => {
    const take = vi.fn(async () => {});
    const acknowledgeLost = vi.fn();
    render(<CheckoutLostDialog checkout={lost({ take, acknowledgeLost })} noun="design" />);

    await userEvent.click(screen.getByRole('button', { name: /stay read only/i }));

    expect(acknowledgeLost).toHaveBeenCalledOnce();
    expect(take).not.toHaveBeenCalled();
  });

  it('does not offer to take it back twice while one is in flight', () => {
    render(<CheckoutLostDialog checkout={lost({ busy: true })} noun="design" />);
    expect(screen.getByRole('button', { name: /taking/i })).toBeDisabled();
  });
});

describe('the desktop notification is best effort', () => {
  it('still renders where Notification does not exist', () => {
    // jsdom has no Notification, which is exactly the unsupported-browser case.
    expect(globalThis.Notification).toBeUndefined();
    expect(() =>
      render(<CheckoutLostDialog checkout={lost()} noun="design" name="Booster v3" />),
    ).not.toThrow();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('still renders when permission was denied', () => {
    vi.stubGlobal('Notification', class {
      static permission = 'denied';
      close() {}
    });
    expect(() => render(<CheckoutLostDialog checkout={lost()} noun="design" />)).not.toThrow();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('posts one when permission was granted, and closes it on the way out', () => {
    const close = vi.fn();
    const ctor = vi.fn();
    vi.stubGlobal('Notification', class {
      static permission = 'granted';
      close = close;
      constructor(title: string, opts?: unknown) { ctor(title, opts); }
    });

    const view = render(<CheckoutLostDialog checkout={lost()} noun="design" name="Booster v3" />);
    expect(ctor).toHaveBeenCalledOnce();
    // A tag, so a second loss replaces the first rather than stacking notifications.
    expect(ctor.mock.calls[0][1]).toMatchObject({ tag: expect.any(String) });

    view.unmount();
    expect(close).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
