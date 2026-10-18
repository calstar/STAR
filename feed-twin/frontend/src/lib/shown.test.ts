import { describe, expect, it } from 'vitest';
import { NONE, moveTo, ordered, setAll, toggle, visible } from './shown';

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

describe('the order the console draws things in', () => {
  it('puts what the order names first, the rest after in their own order', () => {
    expect(ordered(['a', 'b', 'c', 'd'], ['c', 'a'], (x) => x)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('moves a dragged item onto the one it is dropped on', () => {
    expect(moveTo(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
    expect(moveTo(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    expect(moveTo(['a', 'b'], 'a', 'a')).toEqual(['a', 'b']);
  });
});
