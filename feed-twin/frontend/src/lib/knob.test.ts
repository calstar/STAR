import { describe, expect, it } from 'vitest';
import { nextDetent } from '../components/Knob';
import { fromPsia, toPsia } from './pressure';

/**
 * A knob reads psia and its detents are psia, but the settings it starts
 * from are gauge: 500 psig is 514.7 psia, 0.3 psi short of a 5 psi detent and
 * 14.7 past a 50 psi one. A click goes to the next detent that way.
 */
describe('a click on a knob goes to the next detent', () => {
  it('from a gauge setting, lands on the nearer detent first', () => {
    const copv = toPsia(4500); // 4,514.7 psia on a 50 psi detent
    expect(nextDetent(copv, 50, -1, 1, toPsia(0), toPsia(6000))).toBe(4500);
    expect(nextDetent(copv, 50, 1, 1, toPsia(0), toPsia(6000))).toBe(4550);
    const dome = toPsia(450); // 464.7 psia on a 5 psi detent
    expect(nextDetent(dome, 5, 1, 1, toPsia(0), toPsia(1000))).toBe(465);
    expect(nextDetent(dome, 5, -1, 1, toPsia(0), toPsia(1000))).toBe(460);
  });

  it('from a detent, moves a whole detent', () => {
    expect(nextDetent(470, 5, 1, 1, 0, 1000)).toBe(475);
    expect(nextDetent(470, 5, -1, 1, 0, 1000)).toBe(465);
    expect(nextDetent(470, 5, 1, 10, 0, 1000)).toBe(520);
  });

  it('stops at the ends of its travel', () => {
    const vented = toPsia(0);
    expect(nextDetent(17, 5, -1, 1, vented, toPsia(1000))).toBe(15);
    expect(nextDetent(15, 5, -1, 1, vented, toPsia(1000))).toBe(vented);
    expect(fromPsia(nextDetent(15, 5, -1, 1, vented, toPsia(1000)))).toBe(0);
    expect(nextDetent(toPsia(1000) - 1, 5, 1, 1, vented, toPsia(1000))).toBe(toPsia(1000));
  });
});
