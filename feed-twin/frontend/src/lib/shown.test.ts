import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NONE, readHidden, setAll, toggle, visible, writeHidden } from './shown';

describe('what the console hides', () => {
  it('hides an item and shows it again', () => {
    const once = toggle(NONE, 'pts', 'PT-OX-UP');
    expect(visible(once, 'pts', 'PT-OX-UP')).toBe(false);
    expect(visible(toggle(once, 'pts', 'PT-OX-UP'), 'pts', 'PT-OX-UP')).toBe(true);
  });

  it('keeps panels apart: hiding a transducer hides no valve of the same id', () => {
    const h = toggle(NONE, 'pts', 'X');
    expect(visible(h, 'actuators', 'X')).toBe(true);
  });

  it('never hides trouble: a hidden item that needs watching is drawn', () => {
    const h = setAll(NONE, 'actuators', ['SV-LOX-MAIN', 'SV-FU-MAIN'], false);
    expect(visible(h, 'actuators', 'SV-LOX-MAIN')).toBe(false);
    expect(visible(h, 'actuators', 'SV-LOX-MAIN', true)).toBe(true);
  });

  it('shows a whole panel again at once', () => {
    const h = setAll(NONE, 'tanks', ['TK-LOX', 'TK-FUEL'], false);
    expect(setAll(h, 'tanks', [], true).tanks).toEqual([]);
  });
});

describe('remembering it, per stand', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    };
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('keeps one stand\'s choices off another', () => {
    writeHidden('ethalox', toggle(NONE, 'pts', 'PT-OX-UP'));
    expect(readHidden('ethalox').pts).toEqual(['PT-OX-UP']);
    expect(readHidden('other-stand')).toEqual(NONE);
  });

  it('forgets a stand with nothing hidden rather than storing an empty entry', () => {
    writeHidden('ethalox', toggle(NONE, 'pts', 'PT-OX-UP'));
    writeHidden('ethalox', NONE);
    expect(store.size).toBe(0);
  });

  it('reads a damaged entry as nothing hidden', () => {
    store.set('feedtwin.console.hidden.ethalox', '{not json');
    expect(readHidden('ethalox')).toEqual(NONE);
    store.set('feedtwin.console.hidden.ethalox', JSON.stringify({ pts: [3, 'PT-A'], tanks: 'x' }));
    expect(readHidden('ethalox')).toEqual({ pts: ['PT-A'], tanks: [], actuators: [] });
  });

  it('still works with storage that throws', () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => { throw new Error('blocked'); },
        setItem: () => { throw new Error('blocked'); },
        removeItem: () => { throw new Error('blocked'); },
      },
    };
    expect(readHidden('ethalox')).toEqual(NONE);
    expect(() => writeHidden('ethalox', toggle(NONE, 'pts', 'A'))).not.toThrow();
  });
});
