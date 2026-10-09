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
 * should have one answer for everyone rather than one per browser. The ground
 * support starts hidden (the operator, 2026-10-08: the rocket is what is
 * watched); a cart valve or transducer is put on from the Hookup tab or the
 * menus. The order the strip draws things in is kept the same way.
 *
 * Hiding is never allowed to hide trouble. `visible` brings an item back
 * while it is in a state the operator has to see -- a valve open or held, a
 * transducer past NOP -- whatever the menu says. Not the cart's: its limits
 * are guessed from the tag against the rocket's tanks, and an overpressure
 * trips the stand anyway.
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

/** The order the console draws its transducers and tanks in, by drawing id.
 *  Ids not listed follow, in the drawing's own order. */
export type Order = { pts: string[]; tanks: string[] };
export const NO_ORDER: Order = { pts: [], tanks: [] };

/** The console's whole view, as a stand keeps it: everything off it, and the
 *  order. */
export type ConsoleView = { hidden: string[]; order: Order };

/** `items` in `order`; anything it does not name keeps its place after. */
export function ordered<T>(items: readonly T[], order: readonly string[], idOf: (t: T) => string): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  const known = items.filter((t) => rank.has(idOf(t))).sort((a, b) => rank.get(idOf(a))! - rank.get(idOf(b))!);
  return [...known, ...items.filter((t) => !rank.has(idOf(t)))];
}

/** The order with `dragged` moved to where `target` is (`ids` the panel's
 *  items as drawn now, so a first drag fixes the whole order). */
export function moveTo(ids: readonly string[], dragged: string, target: string): string[] {
  if (dragged === target) return [...ids];
  const rest = ids.filter((id) => id !== dragged);
  const at = rest.indexOf(target);
  const from = ids.indexOf(dragged);
  const to = ids.indexOf(target);
  // Dropped on an item further down: after it; further up: before it.
  rest.splice(at < 0 ? rest.length : from < to ? at + 1 : at, 0, dragged);
  return rest;
}
