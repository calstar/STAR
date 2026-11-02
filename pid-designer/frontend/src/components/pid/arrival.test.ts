// Arriving on a page (arrival.ts): a tall page is put up readable, from its
// top, not whole at a size nobody can read.
import { describe, expect, it } from 'vitest';
import { arrivalViewport, sheetMeasured } from './arrival';

describe('when a page is ready to be put up', () => {
  type N = { hidden?: boolean; measured: { width?: number; height?: number } };
  const sized = { measured: { width: 60, height: 40 } };
  const unsized: N = { measured: {} };
  // The canvas's lookup one frame after "GSE" was clicked: the Rocket page
  // still measured, the GSE page shown but only partly measured.
  const lookup = new Map<string, N>([
    ['rocket-tank', { ...sized, hidden: true }],
    ['ox-vent', sized],
    ['pr-1', unsized],
    ['hp-qd-a', unsized],
  ]);
  const gse = ['ox-vent', 'pr-1', 'hp-qd-a'];

  it('waits until every symbol on the page has a size', () => {
    // A fit taken now framed the few measured symbols at 2x (H063).
    expect(sheetMeasured(lookup, gse)).toBe(false);
    lookup.set('pr-1', sized);
    lookup.set('hp-qd-a', sized);
    expect(sheetMeasured(lookup, gse)).toBe(true);
  });

  it('is not ready on a page the canvas has not put up yet', () => {
    // The store still showing the page left: the asked-for symbols are hidden.
    expect(sheetMeasured(lookup, ['rocket-tank'])).toBe(false);
    expect(sheetMeasured(lookup, ['not-there'])).toBe(false);
    expect(sheetMeasured(lookup, [])).toBe(false);
  });
});

// The LE4 stand's Rocket page as the 1080p editor measures it: a 690 x 1410
// column in a 1672 x 939 pane, which framed whole came out at 0.65.
const pane = { width: 1672, height: 939 };
const rocket = { x: 400, y: 20, width: 690, height: 1410 };

describe('arriving on a page', () => {
  it('puts a tall page up at 1:1 from its top, centred across', () => {
    const v = arrivalViewport(rocket, pane, 0.03);
    expect(v).not.toBeNull();
    expect(v!.zoom).toBe(1);
    // The page's top edge is at the top of the pane, inside the padding.
    expect(v!.y + rocket.y * v!.zoom).toBeGreaterThanOrEqual(0);
    expect(v!.y + rocket.y * v!.zoom).toBeLessThan(20);
    // And its middle across is the pane's.
    expect(v!.x + (rocket.x + rocket.width / 2) * v!.zoom).toBeCloseTo(pane.width / 2);
  });

  it('a page too wide for 1:1 shows its whole width from the top', () => {
    const wide = { x: 0, y: 0, width: 3000, height: 6000 };
    const v = arrivalViewport(wide, pane, 0.03)!;
    expect(v.zoom).toBeLessThan(1);
    expect(v.zoom * wide.width).toBeLessThanOrEqual(pane.width);
    expect(v.zoom * wide.width).toBeGreaterThan(pane.width * 0.9);
  });

  it('frames whole what fits at 1:1, and a page its width limits', () => {
    expect(arrivalViewport({ x: 0, y: 0, width: 600, height: 400 }, pane, 0.03)).toBeNull();
    expect(arrivalViewport({ x: 0, y: 0, width: 4000, height: 900 }, pane, 0.03)).toBeNull();
    expect(arrivalViewport({ x: 0, y: 0, width: 0, height: 0 }, pane, 0.03)).toBeNull();
  });
});
