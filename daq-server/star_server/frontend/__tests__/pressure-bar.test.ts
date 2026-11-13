/**
 * The safety property of a pressure bar, stated as assertions.
 *
 * A stale sensor used to render as an EMPTY bar wearing the GREEN below-NOP colour, on
 * both the bar and the readout — visually identical to a genuinely vented tank. That came
 * from `const displayValue = value ?? 0`, which substitutes a reading the rig never sent.
 *
 * "No reading" and "zero" must never draw the same, because on a pressurised stand the
 * difference is the whole message.
 */
import { describe, it, expect } from 'vitest';
import { pressureBarVisual, NO_DATA_COLOR } from '../components/plots/PressureBar';

const NOP = 500;
const MEOP = 700;
/** The threshold palette. A no-data bar must not wear any of these. */
const THRESHOLD_COLORS = ['#27AE60', '#F39C12', '#E74C3C'];

describe('pressureBarVisual — no data vs zero', () => {
  it('marks a null reading as noData and draws nothing', () => {
    const v = pressureBarVisual(null, NOP, MEOP);
    expect(v.noData).toBe(true);
    expect(v.sane).toBe(false);
    expect(v.displayHeight).toBe(0);
  });

  it('never colours a no-data bar with a threshold colour', () => {
    const v = pressureBarVisual(null, NOP, MEOP);
    expect(THRESHOLD_COLORS).not.toContain(v.barColor);
    expect(v.barColor).toBe(NO_DATA_COLOR);
  });

  it('ignores an explicit colour override when there is no data', () => {
    // A caller-supplied colour must not resurrect a confident-looking bar.
    const v = pressureBarVisual(null, NOP, MEOP, '#27AE60');
    expect(v.barColor).toBe(NO_DATA_COLOR);
  });

  it('treats a real zero as DATA, not as absence', () => {
    const v = pressureBarVisual(0, NOP, MEOP);
    expect(v.noData).toBe(false);
    expect(v.sane).toBe(true);
    // A measured 0 psi is a legitimate reading and keeps its threshold colour.
    expect(v.barColor).not.toBe(NO_DATA_COLOR);
  });

  it('distinguishes no-data from zero — the regression this file exists for', () => {
    const absent = pressureBarVisual(null, NOP, MEOP);
    const zero = pressureBarVisual(0, NOP, MEOP);
    expect(absent.noData).not.toBe(zero.noData);
    expect(absent.barColor).not.toBe(zero.barColor);
  });

  it('treats NaN as no data rather than plotting it', () => {
    const v = pressureBarVisual(NaN, NOP, MEOP);
    expect(v.noData).toBe(true);
    expect(v.barColor).toBe(NO_DATA_COLOR);
  });
});

describe('pressureBarVisual — live readings still behave', () => {
  it('colours below NOP, above NOP and above MEOP distinctly', () => {
    const low = pressureBarVisual(100, NOP, MEOP).barColor;
    const mid = pressureBarVisual(600, NOP, MEOP).barColor;
    const high = pressureBarVisual(900, NOP, MEOP).barColor;
    expect(new Set([low, mid, high]).size).toBe(3);
    expect(THRESHOLD_COLORS).toContain(high);
  });

  it('gives a small non-zero reading a visible minimum height', () => {
    const v = pressureBarVisual(1, NOP, MEOP);
    expect(v.displayHeight).toBeGreaterThanOrEqual(2);
  });

  it('rejects an absurd reading as not sane without claiming no data', () => {
    const v = pressureBarVisual(1e9, NOP, MEOP);
    expect(v.noData).toBe(false);   // a value did arrive
    expect(v.sane).toBe(false);     // it is just not plottable
    expect(v.displayHeight).toBe(0);
  });

  it('honours a caller colour override for a real reading', () => {
    expect(pressureBarVisual(100, NOP, MEOP, '#123456').barColor).toBe('#123456');
  });
});
