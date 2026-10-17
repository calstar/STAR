/**
 * What the design bar's autosave tick may do with the backend session it just read.
 *
 * The backend keeps ONE session per user, and every tab shares it. Two things can put a config
 * in it that is not the design this tab shows:
 *
 *  - a restart or an idle eviction: a new session (new epoch) holding configs/default.yaml;
 *  - another tab of the same user loading its own design (new load token, same epoch).
 *
 * Autosaving either into the open design is a silent clobber (2026-10-01: the default saved over
 * an ethalox design; 2026-10-17: a read-only tab re-loading design X after a reload, then the
 * tab holding Y autosaving X into Y). Only the tab holding the checkout may put its design back
 * over anything; a read-only tab may put its design back only over the default, never over a
 * design another tab loaded.
 */

import { stable } from './engineIdentity';

export type TickAction =
  /** Put this tab's last-saved design back into the session. */
  | 'restore'
  /** Another tab's design is in the session: save nothing, say so, offer to reopen. */
  | 'displaced'
  /** The session holds this tab's design: autosave it if it changed (held tabs only). */
  | 'save'
  /** Nothing to do. */
  | 'idle';

export interface TickInput {
  held: boolean;
  /** The epoch this tab loaded its design into (null: none yet). */
  ownEpoch: string | null;
  /** The epoch the session reports now. */
  sessionEpoch: string | null;
  /** The token of this tab's own last load (null: it never loaded one). */
  ownToken: string | null;
  /** The session's token now (null: nobody has loaded anything into it since it was made). */
  sessionToken: string | null;
  /** This tab has a design of its own to put back. */
  haveSaved: boolean;
}

export function tickAction(t: TickInput): TickAction {
  const recreated = !!(t.sessionEpoch && t.ownEpoch && t.sessionEpoch !== t.ownEpoch);
  if (recreated) {
    if (!t.haveSaved) return 'idle';
    // The holder's design is the one being edited: it goes back, over whatever is there.
    if (t.held) return 'restore';
    // A viewer puts its design back only over the default a fresh session starts with. Over a
    // design another tab already loaded it would start the clobber this guard exists for.
    return t.sessionToken === null ? 'restore' : 'displaced';
  }
  if (t.sessionToken !== t.ownToken) return 'displaced';
  return t.held ? 'save' : 'idle';
}

/**
 * Whether this tab may write `doc` over the design it last saved (`lastSavedJson`).
 *
 * Once anybody has used the tab (`touched`) it writes whatever changed. Untouched, it writes only a
 * config that changed under it, never panel state alone: that is what its panels derived from the
 * config on load (Forward Mode's tank pressures, the Time-Series profile), and saving it from a tab
 * nobody touched wrote the design and refreshed the checkout from a second tab of yours, opened
 * beside the one editing.
 */
export function mayWrite(
  doc: { config?: unknown },
  lastSavedJson: string,
  touched: boolean,
): boolean {
  if (touched || !lastSavedJson) return true;
  const saved = JSON.parse(lastSavedJson) as { config?: unknown };
  return stable(doc.config ?? null) !== stable(saved.config ?? null);
}
