import { describe, expect, it } from 'vitest';
import { knobGrab, knobTurn, nextDetent, type KnobGrab } from '../components/Knob';
import { fromPsia, toPsia } from './pressure';

/**
 * A press and a drag on the dome knob (180 px, 14.7 to 1,014.7 psia), as the
 * pointer events give them: points from the dial's centre [px]. The values
 * each move would send, unsnapped.
 */
function drag(points: [number, number][], value = 549.7, half = 90, min = toPsia(0), max = toPsia(1000)): number[] {
  const [first, ...rest] = points;
  let grab: KnobGrab | null = knobGrab(first[0], first[1], half, value);
  const sent: number[] = [];
  for (const [x, y] of rest) {
    if (!grab) break;
    const turn = knobTurn(grab, x, y, half, min, max);
    grab = turn.grab;
    if (turn.value !== null) sent.push(turn.value);
  }
  return sent;
}
const ring = (deg: number, r = 76): [number, number] => [r * Math.sin((deg * Math.PI) / 180), -r * Math.cos((deg * Math.PI) / 180)];

describe('a hand on the knob turns it only by turning it', () => {
  it('six pixels of jitter by the centre send nothing (it sent the dome from 550 to 685 psia)', () => {
    expect(drag([[3, 8], [0, 8], [-3, 8]])).toEqual([]);
  });
  it('a click on the readout under the dial sends nothing', () => {
    expect(drag([[0, 65], [3, 66], [6, 65]])).toEqual([]);
  });
  it('a drag through the centre to the far side does not swing it half its travel', () => {
    const sent = drag([ring(0), ring(10), [0, -20], [0, 4], [0, 30], ring(180), ring(185)]);
    expect(Math.max(...sent.map((v) => Math.abs(v - 549.7)))).toBeLessThan(40);
  });
  it('a deliberate turn of the rim turns it', () => {
    const sent = drag(Array.from({ length: 31 }, (_, i) => ring(i)));
    // 30 degrees round, less the few it takes to break away: about 90 psi up.
    expect(sent.at(-1)! - 549.7).toBeGreaterThan(70);
    expect(sent.at(-1)! - 549.7).toBeLessThan(115);
  });
});

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
