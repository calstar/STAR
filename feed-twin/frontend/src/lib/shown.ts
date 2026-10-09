/**
 * What the console leaves off, per stand.
 *
 * A stand with a dozen transducers, four vessels and a full valve manifold
 * does not fit the strip, and most of it is not what the operator is watching
 * today. Each panel's menu hides what is not; these are the rules for it.
 *
 * The choice itself is kept by the backend, per drawing (backend/overrides.py,
 * `console_hidden`), and set from these menus or the P&ID tab. It is shared:
 * the console is what the stand team watches together, and "who hid PT-FUEL-2"
 * should have one answer for everyone rather than one per browser.
 *
 * Hiding is never allowed to hide trouble. `visible` brings an item back
 * while it is in a state the operator has to see -- a valve open or held, a
 * transducer past NOP -- whatever the menu says.
 */

export type Panel = 'pts' | 'tanks' | 'actuators';
export type Hidden = Record<Panel, string[]>;

export const NONE: Hidden = { pts: [], tanks: [], actuators: [] };

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
