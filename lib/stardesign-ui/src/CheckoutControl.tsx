/**
 * The checkout, in the design bar: what the state is, and the one button that
 * changes it.
 *
 * Deliberately shows the state at all times rather than only when contended.
 * The failure this feature exists to prevent is someone believing they hold a
 * design when they do not, and a control that appears only on conflict leaves
 * the common case ambiguous.
 */

import { useEffect } from 'react';
import type { Checkout } from './useCheckout';
import { btn, primaryBtn } from './theme';

/** Below this many seconds the chip turns amber and offers Keep editing. */
const WARN_AT_S = 120;

function mmss(total: number): string {
  const m = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

export function CheckoutControl({
  checkout,
  noun = 'design',
  disabled = false,
}: {
  checkout: Checkout;
  /** Singular, lower case: "design" / "config" / "diagram". */
  noun?: string;
  /** No design open yet. */
  disabled?: boolean;
}) {
  const { held, holder, holderName, busy, error, take, release } = checkout;
  const { secondsLeft, keepAlive } = checkout;
  const takenByOther = !!holder && !held;
  // Warn before it goes, not after. The complaint this answers is not that the
  // hold lapses -- it is that it lapsed with no warning and no way to stop it.
  const expiringSoon = held && secondsLeft !== null && secondsLeft <= WARN_AT_S;

  const chip =
    'inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium border';
  const dot = 'h-1.5 w-1.5 rounded-full';

  return (
    <span className="inline-flex items-center gap-2">
      {held ? (
        <>
          <span
            className={
              expiringSoon
                ? `${chip} border-amber-500/50 bg-amber-500/10 text-amber-300`
                : `${chip} border-emerald-600/40 bg-emerald-600/10 text-emerald-400`
            }
            title={
              secondsLeft === null
                ? `You have this ${noun} checked out.`
                : `You have this ${noun} checked out. It returns on its own about ${mmss(secondsLeft)} after you stop working on it — anything you do here keeps it.`
            }
          >
            <span className={`${dot} ${expiringSoon ? 'bg-amber-500' : 'bg-emerald-500'}`} />
            Editing
            {secondsLeft !== null && (
              <span className="tabular-nums opacity-80">· {mmss(secondsLeft)}</span>
            )}
          </span>
          {expiringSoon && (
            <button
              onClick={() => void keepAlive()}
              className={primaryBtn}
              title="Keep this checkout for another full period"
            >
              Keep editing
            </button>
          )}
          <button onClick={() => void release()} disabled={busy} className={btn}>
            {busy ? 'Releasing…' : 'Release'}
          </button>
        </>
      ) : takenByOther ? (
        <span
          className={`${chip} border-amber-500/40 bg-amber-500/10 text-amber-400`}
          title={`${holderName} is editing this ${noun}. You can read it, or take a copy from Change → View only.`}
        >
          <span className={`${dot} bg-amber-500`} />
          <span className="max-w-[16ch] truncate">{holderName} is editing</span>
        </span>
      ) : (
        <>
          <span
            className={`${chip} border-[var(--color-border)] text-[var(--color-text-muted)]`}
            title={`Nobody has this ${noun} checked out. Take it to make changes.`}
          >
            <span className={`${dot} bg-[var(--color-border)]`} />
            Read only
          </span>
          <button
            onClick={() => {
              requestCheckoutNotifications();
              void take();
            }}
            disabled={busy || disabled}
            className={primaryBtn}
            title={`Check out this ${noun} so you can edit it`}
          >
            {busy ? 'Taking…' : 'Take'}
          </button>
        </>
      )}
      {error && <span className="max-w-[28ch] truncate text-xs text-red-500" title={error}>{error}</span>}
    </span>
  );
}

/**
 * The banner shown over a read-only editor.
 *
 * The chip above says what the state is; this says what to do about it, and is
 * the thing that stops "why can't I type in this box".
 */
export function ReadOnlyNotice({
  checkout,
  noun = 'design',
}: {
  checkout: Checkout;
  noun?: string;
}) {
  if (checkout.held) return null;
  const { holder, holderName } = checkout;
  return (
    <div className="flex items-start gap-2 rounded border border-amber-500/50 bg-amber-500/10 px-3 py-2">
      <span className="mt-0.5 text-amber-400">▲</span>
      <p className="text-xs leading-relaxed text-amber-200">
        {holder ? (
          <>
            <b>{holderName}</b> has this {noun} checked out, so it is read only. You can still
            look around, or take your own copy from <b>Change → View only</b>.
          </>
        ) : (
          <>
            Read only — press <b>Take</b> to check this {noun} out before editing.
          </>
        )}
      </p>
    </div>
  );
}


/**
 * Ask once for permission to post a desktop notification when a checkout is
 * lost. Called from the Take click because a permission prompt needs a user
 * gesture, and because asking on page load is what trains people to deny.
 *
 * Best-effort throughout: a denied or unsupported permission simply means the
 * in-page dialog and the tab title are the whole story, which is the case this
 * is designed around anyway -- a closed laptop shows nothing either way.
 */
export function requestCheckoutNotifications(): void {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') void Notification.requestPermission();
  } catch {
    /* some browsers throw on requestPermission in insecure contexts */
  }
}

/**
 * Shown when a checkout goes away without the user releasing it.
 *
 * The whole point is that it is still there when you come back. Losing a design
 * used to be silent: the canvas quietly stopped accepting edits and the only
 * signal was a save failing, which meant people kept working into a void. So
 * this does three things at once, in descending order of reliability:
 *
 *  1. An in-page dialog that persists until acknowledged -- the mechanism.
 *  2. The tab title, so it is visible in the tab strip from another tab.
 *  3. A desktop notification where permission allows -- the only one that can
 *     reach a user who has switched apps, and the only one that is allowed to
 *     fail silently.
 */
export function CheckoutLostDialog({
  checkout,
  noun = 'design',
  name,
}: {
  checkout: Checkout;
  noun?: string;
  /** The design's name, for the notification and the title. */
  name?: string | null;
}) {
  const { lostUnexpectedly, acknowledgeLost, take, busy, holderName } = checkout;

  // Tab title, restored on the way out. Captured per-activation rather than at
  // module scope so it survives the app renaming its own title.
  useEffect(() => {
    if (!lostUnexpectedly || typeof document === 'undefined') return;
    const original = document.title;
    document.title = `⚠ Checkout lost — ${original}`;
    return () => {
      document.title = original;
    };
  }, [lostUnexpectedly]);

  useEffect(() => {
    if (!lostUnexpectedly) return;
    try {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const n = new Notification('Checkout lost', {
        body: `${name ? `"${name}"` : `This ${noun}`} is no longer checked out to you${
          holderName ? ` — ${holderName} has it now` : ''
        }. Open the tab to take it back.`,
        tag: 'stardesign-checkout-lost', // replace, never stack
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
      return () => n.close();
    } catch {
      /* notification construction can throw; the dialog is the real signal */
    }
  }, [lostUnexpectedly, name, noun, holderName]);

  if (!lostUnexpectedly) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="checkout-lost-title"
    >
      <div className="w-full max-w-md rounded-lg border border-amber-500/40 bg-[var(--color-surface,#161616)] p-5 shadow-xl">
        <h2 id="checkout-lost-title" className="text-sm font-semibold text-amber-300">
          Your checkout lapsed
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-[var(--color-text-muted)]">
          {holderName ? (
            <>
              <b>{holderName}</b> has this {noun} now, so it is read only. Anything you
              changed since is still on screen but was not saved to the shared copy.
            </>
          ) : (
            <>
              This {noun} is read only again. It is free, so you can take it straight back —
              anything you changed since is still on screen but was not saved to the shared
              copy.
            </>
          )}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={acknowledgeLost} className={btn}>
            Stay read only
          </button>
          <button
            onClick={() => {
              void take().then(acknowledgeLost);
            }}
            disabled={busy}
            className={primaryBtn}
          >
            {busy ? 'Taking…' : 'Take it back'}
          </button>
        </div>
      </div>
    </div>
  );
}
