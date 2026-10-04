import { useEffect, useRef } from 'react';
import type { TimeStore } from './store';

/**
 * The page's keyboard, bound to the TimeStore:
 *
 *   Space        play / pause
 *   ← / →        one sample (Shift: ten)
 *   [ / ]        previous / next event
 *   Home / End   T−0 / burnout
 *
 * The shell adds its own (C, 1–8, R, ?, \) through `extra`, keyed by `KeyboardEvent.key`. An
 * `extra` binding wins over a time binding with the same key. Nothing fires while a person types
 * in a field, a select or an editable region, with a modifier held (Ctrl/Meta/Alt; Shift is
 * allowed), when a focused control already handled the key (`defaultPrevented`), or for Space
 * and Enter on a focused button, link or tab, which they press.
 */

export type ShortcutMap = Record<string, (e: KeyboardEvent) => void>;

/** Whether a key event comes from somewhere a person is typing. */
export function isTyping(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  return !!el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}

const SPACE_OWNERS = 'button, a[href], summary, [role="button"], [role="menuitem"], [role="menuitemradio"], ' +
  '[role="menuitemcheckbox"], [role="option"], [role="checkbox"], [role="switch"], [role="radio"], [role="tab"]';

/** Whether Space already means "press this" where the key landed (a focused button or tab). */
export function ownsSpace(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  return !!(target as Element).closest(SPACE_OWNERS);
}

/** The time bindings as a map, so they can be listed on the shortcut sheet and tested. */
export function timeShortcuts(store: TimeStore): ShortcutMap {
  return {
    ' ': () => store.togglePlaying(),
    ArrowLeft: (e) => store.step(e.shiftKey ? -10 : -1),
    ArrowRight: (e) => store.step(e.shiftKey ? 10 : 1),
    '[': () => {
      store.nextEvent(-1);
    },
    ']': () => {
      store.nextEvent(1);
    },
    Home: () => store.home(),
    End: () => store.end(),
  };
}

/**
 * Runs the binding for one key event; true when one ran (and the event was prevented). Exposed for
 * tests and for a shell that wants to route keys itself.
 */
export function dispatchShortcut(e: KeyboardEvent, maps: ShortcutMap[]): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
  if (isTyping(e.target)) return false;
  if ((e.key === ' ' || e.key === 'Enter') && ownsSpace(e.target)) return false;
  // Keyed by what was typed ('?' is Shift+/ on most layouts); a letter also matches its lower
  // case, so 'c' covers C with Caps Lock or Shift.
  const lower = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  for (const m of maps) {
    const own = (k: string) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : undefined);
    const fn = own(e.key) ?? own(lower);
    if (fn) {
      e.preventDefault();
      fn(e);
      return true;
    }
  }
  return false;
}

/**
 * Binds the shortcuts on `window` while mounted. `extra` may change every render; the latest is
 * used without rebinding. Pass `store: null` to bind only `extra` (Injector and Optimize, which
 * have no timeline). Returns nothing; the binding is dropped on unmount.
 */
export function useShortcuts(store: TimeStore | null, extra?: ShortcutMap, opts: { enabled?: boolean } = {}): void {
  const extraRef = useRef<ShortcutMap | undefined>(extra);
  useEffect(() => {
    extraRef.current = extra;
  });
  const enabled = opts.enabled ?? true;
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const time = store ? timeShortcuts(store) : {};
    const onKey = (e: KeyboardEvent) => {
      dispatchShortcut(e, [extraRef.current ?? {}, time]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, enabled]);
}

/** For a non-React caller: bind and get the cleanup back. */
export function bindShortcuts(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, store: TimeStore | null, extra: ShortcutMap = {}): () => void {
  const time = store ? timeShortcuts(store) : {};
  const onKey = (e: Event) => {
    dispatchShortcut(e as KeyboardEvent, [extra, time]);
  };
  target.addEventListener('keydown', onKey);
  return () => target.removeEventListener('keydown', onKey);
}
