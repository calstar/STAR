import { describe, expect, it } from 'vitest';
import { createTimeStore, type TimeClock } from './store';
import { bindShortcuts, dispatchShortcut, timeShortcuts, type ShortcutMap } from './useShortcuts';

/** A stand-in for a DOM element: `closest` answers by the selectors it is said to match. */
function el(matches: (sel: string) => boolean, editable = false) {
  return { isContentEditable: editable, closest: (sel: string) => (sel.split(',').some((s) => matches(s.trim())) ? {} : null) };
}
const BODY = el(() => false);
const INPUT = el((s) => s === 'input');
const TEXTAREA = el((s) => s === 'textarea');
const SELECT = el((s) => s === 'select');
const EDITABLE = el(() => false, true);
const BUTTON = el((s) => s === 'button');

function key(k: string, target: unknown = BODY, mods: Partial<KeyboardEvent> = {}) {
  let prevented = false;
  return {
    key: k, target, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false,
    get defaultPrevented() { return prevented; },
    preventDefault() { prevented = true; },
    ...mods,
  } as unknown as KeyboardEvent;
}

/** Frames never come on their own; `flush()` publishes. Playback therefore stays put. */
const idleClock: Partial<TimeClock> = { raf: () => 1, caf: () => {}, reducedMotion: () => false };

function setup() {
  const store = createTimeStore({ clock: idleClock });
  store.setSeries(Array.from({ length: 101 }, (_, i) => i / 100));
  store.setEvents([{ t: 0.2, key: 'fire', label: 'Fire', kind: 'fire' }, { t: 0.9, key: 'burnout', label: 'Burnout', kind: 'burnout' }]);
  store.setT(0.5);
  store.flush();
  return { store, maps: [timeShortcuts(store)] as ShortcutMap[] };
}

describe('dispatchShortcut', () => {
  it('drives the store: arrows, Shift ×10, brackets, Home, End, Space', () => {
    const { store, maps } = setup();
    expect(dispatchShortcut(key('ArrowRight'), maps)).toBe(true);
    expect((store.flush(), store.get().t)).toBe(0.51);
    dispatchShortcut(key('ArrowLeft', BODY, { shiftKey: true }), maps);
    expect((store.flush(), store.get().t)).toBe(0.41);
    dispatchShortcut(key(']'), maps);
    expect((store.flush(), store.get().t)).toBe(0.9);
    dispatchShortcut(key('['), maps);
    expect((store.flush(), store.get().t)).toBe(0.2);
    dispatchShortcut(key('End'), maps);
    expect((store.flush(), store.get().t)).toBe(0.9);
    dispatchShortcut(key('Home'), maps);
    expect((store.flush(), store.get().t)).toBe(0);
    dispatchShortcut(key(' '), maps);
    expect(store.get().playing).toBe(true);
  });

  it('ignores keys typed into fields, selects and editable text', () => {
    const { store, maps } = setup();
    for (const target of [INPUT, TEXTAREA, SELECT, EDITABLE]) {
      const e = key('ArrowRight', target);
      expect(dispatchShortcut(e, maps)).toBe(false);
      expect(e.defaultPrevented).toBe(false);
    }
    expect((store.flush(), store.get().t)).toBe(0.5);
  });

  it('ignores modified keys and keys a focused control already handled', () => {
    const { store, maps } = setup();
    expect(dispatchShortcut(key('ArrowRight', BODY, { metaKey: true }), maps)).toBe(false);
    expect(dispatchShortcut(key('ArrowRight', BODY, { ctrlKey: true }), maps)).toBe(false);
    const handled = key('ArrowRight');
    handled.preventDefault();
    expect(dispatchShortcut(handled, maps)).toBe(false);
    expect((store.flush(), store.get().t)).toBe(0.5);
  });

  it('leaves Space to a focused button', () => {
    const { store, maps } = setup();
    expect(dispatchShortcut(key(' ', BUTTON), maps)).toBe(false);
    expect(store.get().playing).toBe(false);
    // Arrows still scrub from a button.
    expect(dispatchShortcut(key('ArrowRight', BUTTON), maps)).toBe(true);
  });

  it('runs the shell\'s extra keys first, a letter in either case', () => {
    const { store, maps } = setup();
    const hits: string[] = [];
    const extra: ShortcutMap = { c: () => hits.push('compare'), '?': () => hits.push('sheet'), ' ': () => hits.push('mine') };
    dispatchShortcut(key('C'), [extra, ...maps]);
    dispatchShortcut(key('?'), [extra, ...maps]);
    dispatchShortcut(key(' '), [extra, ...maps]);
    expect(hits).toEqual(['compare', 'sheet', 'mine']);
    expect(store.get().playing).toBe(false);
    expect(dispatchShortcut(key('x'), [extra, ...maps])).toBe(false);
  });
});

describe('bindShortcuts', () => {
  it('listens until the cleanup runs', () => {
    const { store } = setup();
    const handlers = new Set<(e: Event) => void>();
    const target = {
      addEventListener: (_: string, h: (e: Event) => void) => handlers.add(h),
      removeEventListener: (_: string, h: (e: Event) => void) => handlers.delete(h),
    } as unknown as Window;
    const off = bindShortcuts(target, store);
    for (const h of handlers) h(key('ArrowRight') as unknown as Event);
    expect((store.flush(), store.get().t)).toBe(0.51);
    off();
    expect(handlers.size).toBe(0);
  });
});
