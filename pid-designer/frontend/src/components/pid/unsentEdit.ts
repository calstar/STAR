/**
 * An edit the tab closed on before it was sent.
 *
 * On a developer's own machine nothing holds a diagram until the first edit
 * takes it (`takeOnEdit`), and that happens in the debounced autosave, a
 * second after the drawing stops changing. The flush on tab close sends only
 * for a holder -- a beacon cannot read a refusal -- so an edit made in the
 * second before the tab closed, or after a hold lapsed, was neither sent nor
 * kept anywhere.
 *
 * Now it is kept on this machine, with the drawing as the server had it when
 * the edit was drawn on it (`base`), and the next open of that diagram decides
 * (`unsentFate`): offer to put it back when the server still has that base;
 * keep it as a diagram of the user's own when somebody has saved over it since
 * -- writing it would overwrite their work, as `firstEdit` refuses to.
 */

import type { Snapshot } from '../../api/diagrams';

export interface UnsentEdit {
  /** The drawing as the server had it when the edit was made (serialised `toStored`). */
  base: string;
  /** The drawing with the edit, as stored. */
  doc: Snapshot;
  /** When it was kept (ms since the epoch). */
  at: number;
}

/** `none`: nothing to do (and drop any kept copy); `offer`: ask to put it back; `keep`: save it as a copy. */
export type UnsentFate = 'none' | 'offer' | 'keep';

const PREFIX = 'pid:unsent:';

function local(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // blocked site data
  }
}

/** Keep `edit` for the diagram `key` (a `keyOf` ref). Best effort: storage can be full or blocked. */
export function keepUnsent(key: string, edit: UnsentEdit, store: Storage | null = local()): void {
  try {
    store?.setItem(PREFIX + key, JSON.stringify(edit));
  } catch {
    // Full or blocked: nothing more can be done from a closing tab.
  }
}

/** The edit kept for `key`, if one is and it reads. */
export function readUnsent(key: string, store: Storage | null = local()): UnsentEdit | null {
  try {
    const raw = store?.getItem(PREFIX + key);
    if (!raw) return null;
    const e = JSON.parse(raw) as UnsentEdit;
    return typeof e?.base === 'string' && Array.isArray(e?.doc?.nodes) && Array.isArray(e?.doc?.edges) ? e : null;
  } catch {
    return null;
  }
}

/**
 * Forget the edit kept for `key` -- only the one that is `doc`, when given, so
 * a save of an older state does not drop a newer edit kept after it.
 */
export function dropUnsent(key: string, doc?: string, store: Storage | null = local()): void {
  try {
    if (doc !== undefined) {
      const e = readUnsent(key, store);
      if (e && JSON.stringify(e.doc) !== doc) return;
    }
    store?.removeItem(PREFIX + key);
  } catch {
    // Blocked: it is offered again, and found already saved.
  }
}

/**
 * What opening the diagram does with a kept edit. `server` is the drawing as
 * the server has it now and `shown` as it was put on screen (both serialised
 * `toStored`; opening runs `migrate`, so they can differ with no edit).
 */
export function unsentFate(edit: UnsentEdit | null, opened: { server: string; shown: string }): UnsentFate {
  if (!edit) return 'none';
  const doc = JSON.stringify(edit.doc);
  if (doc === opened.server || doc === opened.shown) return 'none'; // it arrived after all
  return edit.base === opened.server ? 'offer' : 'keep';
}
