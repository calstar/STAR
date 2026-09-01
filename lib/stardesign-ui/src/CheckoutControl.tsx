/**
 * The checkout, in the design bar: what the state is, and the one button that
 * changes it.
 *
 * Deliberately shows the state at all times rather than only when contended.
 * The failure this feature exists to prevent is someone believing they hold a
 * design when they do not, and a control that appears only on conflict leaves
 * the common case ambiguous.
 */

import type { Checkout } from './useCheckout';
import { ghostBtn, primaryBtn } from './theme';

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
  const takenByOther = !!holder && !held;

  const chip =
    'inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium border';
  const dot = 'h-1.5 w-1.5 rounded-full';

  return (
    <span className="inline-flex items-center gap-2">
      {held ? (
        <>
          <span
            className={`${chip} border-emerald-600/40 bg-emerald-600/10 text-emerald-400`}
            title={`You have ${noun === 'config' ? 'this config' : `this ${noun}`} checked out. It returns on its own if you stop editing.`}
          >
            <span className={`${dot} bg-emerald-500`} />
            Editing
          </span>
          <button onClick={() => void release()} disabled={busy} className={ghostBtn}>
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
            onClick={() => void take()}
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
