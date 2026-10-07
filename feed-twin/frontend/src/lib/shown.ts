/**
 * What the console leaves off, per stand.
 *
 * A stand with a dozen transducers, four vessels and a full valve manifold
 * does not fit the strip, and most of it is not what the operator is watching
 * today. Each panel's menu hides what is not; this is where that is kept.
 *
 * Kept by the drawing's id, because ids are the drawing's: PT-OX-UP on one
 * stand is not the same instrument on another, and hiding it on one must not
 * hide it on the next. Kept in this browser only -- it is a view, not the
 * stand, and nobody else's console should change because you tidied yours.
 *
 * Hiding is never allowed to hide trouble. `visible` brings an item back
 * while it is in a state the operator has to see -- a valve open or held, a
 * transducer past NOP -- whatever the menu says.
 */

export type Panel = 'pts' | 'tanks' | 'actuators';
export type Hidden = Record<Panel, string[]>;

export const NONE: Hidden = { pts: [], tanks: [], actuators: [] };

const key = (diagramId: string) => `feedtwin.console.hidden.${diagramId}`;

export function readHidden(diagramId: string): Hidden {
  try {
    const raw = window.localStorage.getItem(key(diagramId));
    if (!raw) return NONE;
    const parsed = JSON.parse(raw) as Partial<Hidden>;
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return { pts: ids(parsed.pts), tanks: ids(parsed.tanks), actuators: ids(parsed.actuators) };
  } catch {
    return NONE;
  }
}

export function writeHidden(diagramId: string, hidden: Hidden): void {
  try {
    const empty = !hidden.pts.length && !hidden.tanks.length && !hidden.actuators.length;
    if (empty) window.localStorage.removeItem(key(diagramId));
    else window.localStorage.setItem(key(diagramId), JSON.stringify(hidden));
  } catch {
    /* private window or storage full: the choice lasts the session */
  }
}

/** `hidden` with one item flipped. */
export function toggle(hidden: Hidden, panel: Panel, id: string): Hidden {
  const list = hidden[panel];
  return { ...hidden, [panel]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] };
}

/** `hidden` with a whole panel shown, or every one of `ids` hidden. */
export function setAll(hidden: Hidden, panel: Panel, ids: string[], show: boolean): Hidden {
  return { ...hidden, [panel]: show ? [] : [...ids] };
}

/**
 * Whether an item is drawn: shown in the menu, or hidden but needing to be
 * seen anyway. `urgent` is the panel's own test for that.
 */
export const visible = (hidden: Hidden, panel: Panel, id: string, urgent = false) =>
  urgent || !hidden[panel].includes(id);
