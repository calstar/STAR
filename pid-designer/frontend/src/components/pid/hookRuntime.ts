/**
 * Just enough of React's hooks to run one component in a test with no DOM.
 *
 * Server rendering draws a component once and never runs its effects, and
 * what several components here get wrong happens in an effect or on a later
 * render: a draft that should follow the dialog, a subscription to the
 * canvas's store, a value that should keep its identity between renders.
 * This keeps one instance's state, refs and memos between calls, runs its
 * effects after each render, and re-renders when an effect sets state, which
 * is all those need. Children are not rendered: a component's output is the
 * element tree it returns, props and all, to be searched with `find`.
 *
 * Used by mocking 'react' with `hooks` in place of the real ones, from a test
 * file's `vi.mock` factory.
 */
import type { ReactElement } from 'react';

type Slot = { deps?: unknown[]; value?: unknown; cleanup?: () => void; setup?: () => void | (() => void) };

let slots: Slot[] = [];
let cursor = 0;
let effects: (() => void)[] = [];
let stateSet = false;

const changed = (a?: unknown[], b?: unknown[]) =>
  !a || !b || a.length !== b.length || a.some((x, k) => !Object.is(x, b[k]));

export const hooks = {
  useState(init: unknown) {
    const k = cursor++;
    if (!slots[k]) slots[k] = { value: typeof init === 'function' ? (init as () => unknown)() : init };
    const s = slots[k];
    const set = (v: unknown) => {
      const next = typeof v === 'function' ? (v as (p: unknown) => unknown)(s.value) : v;
      if (!Object.is(next, s.value)) stateSet = true;
      s.value = next;
    };
    return [s.value, set];
  },
  useMemo(f: () => unknown, deps?: unknown[]) {
    const k = cursor++;
    const s = slots[k];
    if (s && !changed(s.deps, deps)) return s.value;
    slots[k] = { deps, value: f() };
    return slots[k].value;
  },
  useCallback(f: unknown, deps?: unknown[]) { return hooks.useMemo(() => f, deps); },
  useRef(v: unknown) {
    const k = cursor++;
    if (!slots[k]) slots[k] = { value: { current: v } };
    return slots[k].value;
  },
  useEffect(f: () => void | (() => void), deps?: unknown[]) {
    const k = cursor++;
    const s = slots[k];
    if (s && deps && !changed(s.deps, deps)) return;
    const slot: Slot = { deps, cleanup: s?.cleanup, setup: f };
    slots[k] = slot;
    effects.push(() => {
      slot.cleanup?.();
      const c = f();
      slot.cleanup = typeof c === 'function' ? c : undefined;
    });
  },
  useLayoutEffect(f: () => void | (() => void), deps?: unknown[]) { hooks.useEffect(f, deps); },
  useContext(ctx: { _currentValue: unknown }) { return ctx._currentValue; },
  // What the store holds now; a test that changes the store renders again to
  // see it. Subscribed as React subscribes -- after the render, again when the
  // subscription changes, and undone on reset -- and what the store says is
  // counted (`rt.heard`), so a test can see that a change reaches the instance.
  useSyncExternalStore(subscribe: (l: () => void) => () => void, getSnapshot: () => unknown) {
    hooks.useEffect(() => subscribe(() => { heard++; }), [subscribe]);
    return getSnapshot();
  },
};

let heard = 0;

export const rt = {
  /** One render of the one instance, then its effects. */
  render<T>(fn: () => T): T {
    cursor = 0;
    const out = fn();
    const fx = effects;
    effects = [];
    fx.forEach(f => f());
    return out;
  },
  /** Render, and again for as long as the effects keep setting state -- what React does. */
  settle<T>(fn: () => T): T {
    for (let i = 0; i < 20; i++) {
      stateSet = false;
      const out = rt.render(fn);
      if (!stateSet) return out;
    }
    throw new Error('the effects never stopped setting state');
  },
  /** How many times a store the instance subscribes to has said it changed, since the last time this was asked. */
  heard() {
    const n = heard;
    heard = 0;
    return n;
  },
  /**
   * What StrictMode does to a component it has just mounted, in development:
   * run every effect's cleanup, then every effect again, keeping the state
   * and refs. A component whose cleanup leaves a ref saying something is
   * still pending finds it out here.
   */
  strictRemount() {
    const mounted = slots.filter(s => s?.setup);
    mounted.forEach(s => { s.cleanup?.(); s.cleanup = undefined; });
    mounted.forEach(s => { const c = s.setup!(); s.cleanup = typeof c === 'function' ? c : undefined; });
  },
  /** Unmount: run every cleanup and forget the instance. */
  reset() {
    slots.forEach(s => s?.cleanup?.());
    slots = [];
    effects = [];
  },
};

/** Every element in `tree` that `match` accepts, depth first, through `children` only. */
export function find(tree: unknown, match: (e: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== 'object' || !('props' in n)) return;
    const e = n as ReactElement<Record<string, unknown>>;
    if (match(e)) out.push(e);
    walk(e.props.children);
  };
  walk(tree);
  return out;
}

/** The text an element shows, where it is plain text. */
export function textOf(e: ReactElement<Record<string, unknown>>): string {
  const c = e.props.children;
  return (Array.isArray(c) ? c : [c]).filter(x => typeof x === 'string' || typeof x === 'number').join('');
}
