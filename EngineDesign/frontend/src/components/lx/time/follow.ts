import type { TimeStore } from './store';

/**
 * Keeps `to`'s cursor on `from`'s: a view with a clock of its own (the climb to apogee runs long
 * after the burn) still moves with the page, and can be scrubbed on by hand until the page's
 * cursor moves again. `map` turns the page's time into the view's (default: the same clock),
 * and the result is kept inside the view's span. Returns the unsubscribe.
 */
export function followCursor(from: TimeStore, to: TimeStore, map: (t: number) => number = (t) => t): () => void {
  let last = NaN;
  const sync = () => {
    const t = from.get().t;
    if (t === last) return;
    last = t;
    to.setT(map(t));
  };
  sync();
  to.flush();
  return from.subscribe(sync);
}
