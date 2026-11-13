import { describe, expect, it } from 'vitest';
import { paceTick, type PaceWindow } from './pace';

/** `n` ticks 250 ms of wall clock apart, `step` s of stand time each, under
 *  `pacing`, from `window`: the window left and every speed claimed. */
function run(window: PaceWindow | null, from: { wall: number; t: number }, n: number, step: number, pacing: string) {
  const speeds: number[] = [];
  let w = window;
  for (let i = 0; i < n; i++) {
    const r = paceTick(w, from.wall + i * 250, from.t + i * step, pacing);
    w = r.window;
    if (r.speed !== null) speeds.push(r.speed);
  }
  return { window: w, speeds };
}

describe('the speed the top bar claims', () => {
  it('reads 1 on a stand that keeps up', () => {
    const { speeds } = run(null, { wall: 0, t: 0 }, 12, 0.25, 'run1@1');
    expect(speeds.length).toBeGreaterThan(0);
    for (const s of speeds) expect(s).toBeCloseTo(1, 6);
  });

  it('after a ten-second pause, the first ticks claim no slow motion, then 1', () => {
    const before = run(null, { wall: 0, t: 0 }, 4, 0.25, 'run1@1');
    // Resumed: a new run of the tick. The stand carries on from t = 1.0.
    const after = run(before.window, { wall: 10_750, t: 1.0 }, 9, 0.25, 'run2@1');
    expect(after.speeds.length).toBeGreaterThan(0);
    for (const s of after.speeds) expect(s).toBeCloseTo(1, 6);
  });

  it('×1 to ×20 claims nothing until a window at ×20 has run, then 20', () => {
    const at1 = run(null, { wall: 0, t: 0 }, 4, 0.25, 'run1@1');
    const first = paceTick(at1.window, 1000, 1.0 + 5, 'run1@20');
    expect(first).toMatchObject({ speed: null, fresh: true });
    const at20 = run(first.window, { wall: 1250, t: 11 }, 8, 5, 'run1@20');
    for (const s of at20.speeds) expect(s).toBeCloseTo(20, 6);
  });
});
